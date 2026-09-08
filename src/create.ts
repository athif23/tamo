import { basename, join, resolve } from "node:path";
import type { CompositionInput, Recipe } from "./compose.ts";
import { planComposition, verifyComposition } from "./compose.ts";
import { packageManifestHandler } from "./handlers/package-manifest.ts";
import { oxlintConfigHandler } from "./handlers/oxlint-config.ts";
import { edit } from "./jsonc.ts";
import { checkSeedContents } from "./pack.ts";
import { listRecipeNames, loadRecipeTree, mergeSnapshots } from "./recipes.ts";
import { entryType, listDirectory, read } from "./runtime.ts";
import type { Plan } from "./plan.ts";

// Create replays a durable recipe into a new, ordinary project directory
// through the same Core planning path as add: the loaded recipe against an
// empty target, plus a disclosed pnpm install when the recipe contributes a
// manifest. The result carries no Tamo metadata.
export type CreatePreparation = {
  target: string;
  plan?: Plan;
  // The composition input the plan was reviewed against; the caller passes it
  // back to verifyComposition after execution. Data only, not behavior.
  input?: CompositionInput;
  conflicts: string[];
};

// Initial create guard: an absent target is always allowed, an existing
// empty target is allowed, and anything else blocks loudly with zero
// operations. After a successful preparation command intentionally
// populated the target, the fresh stage-2 pass runs inside the same create
// workflow with allowPopulatedTarget, so generated state is not mistaken
// for a pre-existing project. The file check stays on every pass; the
// allowance lives only in the caller's orchestration, never on disk.
async function targetConflicts(target: string, allowPopulatedTarget = false): Promise<string[]> {
  const type = await entryType(target);
  if (type === "file") return [`Target exists and is not a directory: ${target}`];
  if (type === "directory" && !allowPopulatedTarget) {
    const entries = await listDirectory(target);
    if (entries && entries.length)
      return [`Target directory is not empty: ${target}. Existing projects are never overwritten.`];
  }
  return [];
}

// The create workflow owns target identity: stored recipes carry no project
// name, so before planning, the single `name` key is materialized into every
// package.json artifact copy in the record. Same-path contributions carry
// the identical stamped name and dedupe in combination, so no per-instance
// lookup is needed. Core still invents nothing, and the package handler stays
// workflow-independent: it only ever plans what it is given. Targeted text
// edit, not a template language: every other byte of the captured manifest
// survives untouched.
function materializeName(recipes: Record<string, Recipe>, target: string): Record<string, Recipe> {
  const name = basename(target);
  return Object.fromEntries(
    Object.entries(recipes).map(([key, recipe]) => [
      key,
      {
        ...recipe,
        artifacts: recipe.artifacts.map((artifact) =>
          artifact.path === "package.json"
            ? { ...artifact, contents: edit(artifact.contents, ["name"], name) }
            : artifact,
        ),
      },
    ]),
  );
}

// Post-execution checks the recipe path cannot express: the manifest names
// the new target (not the packed source) and the install produced
// node_modules. Replanning completeness is verified separately through
// verifyComposition by the caller.
export async function checkCreated(target: string): Promise<string[]> {
  const errors: string[] = [];
  const manifestText = await read(join(target, "package.json"));
  if (manifestText === null) {
    errors.push(`Created manifest is missing: ${join(target, "package.json")}`);
  } else {
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      errors.push("Created package.json is not valid JSON.");
    }
    if (
      manifest !== undefined &&
      (typeof manifest !== "object" ||
        manifest === null ||
        // SAFETY: the guards above narrowed manifest to a non-array object.
        (manifest as Record<string, unknown>).name !== basename(target))
    )
      errors.push(
        `Created package.json does not name the new target: expected ${basename(target)}.`,
      );
  }
  if ((await entryType(join(target, "node_modules"))) !== "directory")
    errors.push("pnpm install did not produce node_modules.");
  return errors;
}

// Read the manifest name out of planned or on-disk bytes. Both shapes
// parsed cleanly during planning, so a failure here is unexpected rather
// than a new input class.
function plannedName(contents: string): string | undefined {
  // SAFETY: callers only pass handler-planned or previously reviewed
  // manifest bytes, both JSON objects by construction.
  const parsed = JSON.parse(contents) as Record<string, unknown>;
  return typeof parsed.name === "string" ? parsed.name : undefined;
}

function stampFailure(error: unknown): string[] {
  return [
    `Could not stamp the created package name: ${error instanceof Error ? error.message : String(error)}`,
  ];
}

// Stamp the create target name onto the planned package.json result. The
// input-side materializeName covers the absent-target verbatim branch, but
// once a preparation checkpoint populated the target, handlers merge
// against generated state where `name` always belongs to the target — so
// the generated name would survive. This create-owned output surgery keeps
// the reviewed plan honest (the stamped bytes are what review shows) and
// fires only when the planned result actually differs.
function stampPlannedWrite(plan: Plan, target: string): string[] {
  const name = basename(target);
  const manifestPath = join(target, "package.json");
  const write = plan.operations.find(
    (operation) => operation.kind === "write" && operation.path === manifestPath,
  );
  if (write?.kind !== "write") return [];
  try {
    if (plannedName(write.after) !== name) write.after = edit(write.after, ["name"], name);
    return [];
  } catch (error) {
    return stampFailure(error);
  }
}

// Cover the corner where nothing else changed the manifest: without a
// rename write the generated name would survive planning untouched, so one
// is synthesized ahead of the behavior commands to hold the invariant.
async function synthesizeRenameWrite(plan: Plan, target: string): Promise<string[]> {
  const name = basename(target);
  const manifestPath = join(target, "package.json");
  if (
    plan.operations.some(
      (operation) => operation.kind === "write" && operation.path === manifestPath,
    )
  )
    return [];
  const existing = await read(manifestPath);
  if (existing === null) return [];
  try {
    if (plannedName(existing) === name) return [];
    const operation = {
      kind: "write" as const,
      path: manifestPath,
      before: existing,
      after: edit(existing, ["name"], name),
    };
    const firstCommand = plan.operations.findIndex((operation) => operation.kind === "command");
    if (firstCommand < 0) plan.operations.push(operation);
    else plan.operations.splice(firstCommand, 0, operation);
    plan.evidence.push(`set package.json name for created target ${name}`);
    return [];
  } catch (error) {
    return stampFailure(error);
  }
}

export async function planCreate(
  home: string,
  cwd: string,
  targetArgument: string,
  recipeName: string,
  options?: { allowPopulatedTarget?: boolean },
): Promise<CreatePreparation> {
  const target = resolve(cwd, targetArgument);
  const loaded = await loadRecipeTree(home, recipeName);
  if (loaded.conflicts.length) return { target, conflicts: loaded.conflicts };
  const entry = loaded.recipes[recipeName];
  if (!entry) {
    const available = await listRecipeNames(home);
    return {
      target,
      conflicts: [
        `Unknown recipe: ${recipeName}.${available.length ? ` Available: ${available.join(", ")}` : " No recipes are saved yet."}`,
      ],
    };
  }
  let recipes: Record<string, Recipe>;
  try {
    recipes = materializeName(loaded.recipes, target);
  } catch (error) {
    return { target, conflicts: [error instanceof Error ? error.message : String(error)] };
  }
  const recipe = recipes[recipeName]!;

  const seedConflicts = [
    ...(await targetConflicts(target, options?.allowPopulatedTarget)),
    ...Object.values(recipes).flatMap((candidate) => checkSeedContents(candidate.artifacts)),
  ];
  if (seedConflicts.length) return { target, conflicts: seedConflicts };

  const input: CompositionInput = {
    cwd: target,
    recipes,
    entry: recipe.name,
    invocation: [],
    handlers: [packageManifestHandler, oxlintConfigHandler],
    read,
  };
  const prepared = await planComposition(input);
  if (!prepared.plan) return { target, conflicts: prepared.conflicts };
  const plan = prepared.plan;
  // Reviewed inputs cover the loaded tree files too, so a recipe edited
  // between review and execution fails the recheck. The tree loader already
  // scoped snapshots to the selected tree. This holds for
  // preparation plans as well: behavior.mjs stays a reviewed input.
  plan.inputs = mergeSnapshots(plan.inputs, loaded.snapshots);
  // A preparation plan carries only its initializer commands: no name
  // stamping (no writes exist) and no install step. Both belong to the
  // fresh final plan after the replan checkpoint.
  if (plan.requiresReplan) return { target, plan, input, conflicts: [] };
  const stampConflicts = [
    ...stampPlannedWrite(plan, target),
    ...(await synthesizeRenameWrite(plan, target)),
  ];
  if (stampConflicts.length) return { target, conflicts: stampConflicts };
  if (
    Object.values(recipes).some((candidate) =>
      candidate.artifacts.some((artifact) => artifact.path === "package.json"),
    )
  ) {
    plan.operations.push({
      kind: "command",
      executable: "pnpm",
      args: ["install"],
      cwd: target,
      purpose:
        "Install the recipe's dependencies and update the lockfile (lifecycle scripts enabled)",
    });
    plan.evidence.push("install the recipe's dependencies with pnpm install");
  }
  return { target, plan, input, conflicts: [] };
}

export async function verifyCreate(input: CompositionInput, target: string): Promise<string[]> {
  return [...(await verifyComposition(input)), ...(await checkCreated(target))];
}
