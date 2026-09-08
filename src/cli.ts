#!/usr/bin/env node
import { parseArgs } from "node:util";
import { relative, resolve } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Terminal from "effect/Terminal";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { layer as nodeServices } from "@effect/platform-node/NodeServices";
import { tamoHome } from "./home.ts";
import { planCreate, verifyCreate } from "./create.ts";
import { inspectProject, type Inspection } from "./inspect.ts";
import { packRecipe, type PackedRecipe } from "./pack.ts";
import { loadAllRecipes, recipeDir, saveRecipe } from "./recipes.ts";
import { entryType, executePlan, read, type ApplyResult } from "./runtime.ts";
import type { Operation, Plan } from "./plan.ts";
import {
  applyRecipeWithReplan,
  planComposition,
  verifyComposition,
  type CompositionInput,
  type Recipe,
} from "./compose.ts";
import { packageManifestHandler } from "./handlers/package-manifest.ts";
import { oxlintConfigHandler } from "./handlers/oxlint-config.ts";

function showPlan(plan: Plan) {
  console.log(`${plan.subject} in ${plan.cwd}`);

  for (const evidence of plan.evidence) console.log(`  ${evidence}`);
  for (const conflict of plan.conflicts) console.log(`BLOCKED: ${conflict}`);
  if (!plan.operations.length && !plan.conflicts.length) console.log("No changes needed.");

  for (const operation of plan.operations) showOperation(plan, operation);
  if (plan.requiresReplan)
    console.log(
      "\nRequires replan: executing this plan changes project state; review a fresh plan afterwards.",
    );
  console.log(`\nValidate: ${plan.validation.join("; ")}`);
}

function showOperation(plan: Plan, operation: Operation) {
  if (operation.kind === "command") {
    console.log(
      `\nRun: ${operation.executable} ${operation.args.map((arg) => JSON.stringify(arg)).join(" ")}\n  ${operation.purpose}`,
    );
    return;
  }
  console.log(
    `\n${operation.before === null ? "Create" : "Edit"}: ${relative(plan.cwd, operation.path)}`,
  );
  if (operation.before !== null)
    console.log(
      operation.before
        .split(/\r?\n/)
        .map((line) => `- ${line}`)
        .join("\n"),
    );
  console.log(
    operation.after
      .split(/\r?\n/)
      .map((line) => `+ ${line}`)
      .join("\n"),
  );
}

function showInspection(inspection: Inspection) {
  const title =
    inspection.kind === "node"
      ? `Node project${inspection.packageManager ? ` (${inspection.packageManager})` : ""}`
      : "Unknown project kind";
  console.log(`${title} in ${inspection.cwd}`);
  const list = (section: Record<string, string>) =>
    Object.entries(section)
      .map(([name, version]) => `${name}@${version}`)
      .join(", ");
  for (const [label, section] of [
    ["dependencies", inspection.dependencies],
    ["devDependencies", inspection.devDependencies],
  ] as const) {
    const entries = list(section);
    if (entries) console.log(`${label}: ${entries}`);
  }
  if (inspection.configFiles.length)
    console.log(`Config files: ${inspection.configFiles.join(", ")}`);
  for (const note of inspection.notes) console.log(`Note: ${note}`);
}

function showRecipe(recipe: PackedRecipe, target: string) {
  console.log(`Recipe: ${recipe.name}`);
  console.log(
    `Artifacts: ${recipe.artifacts.length ? recipe.artifacts.map((file) => file.path).join(", ") : "(none)"}`,
  );
  console.log(`Save to: ${target}`);
}

// Noninteractive callers get a structured prompt instead of hanging on stdin.
function confirm(question: string, jsonOutput: boolean, payload?: Record<string, unknown>) {
  return Effect.gen(function* () {
    if (!process.stdin.isTTY || jsonOutput) {
      if (jsonOutput) console.log(JSON.stringify({ ...payload, status: "confirmation-required" }));
      else console.error(`Review the ${question}, then pass --yes to apply noninteractively.`);
      process.exitCode = 2;
      return false;
    }
    const terminal = yield* Terminal.Terminal;
    yield* terminal.display(`${question} [y/N] `);
    const answer = yield* terminal.readLine.pipe(
      Effect.catchTag("QuitError", () => Effect.succeed(null)),
    );
    return answer !== null && answer.trim().toLowerCase() === "y";
  });
}

function reportResult(values: { json?: boolean }, plan: Plan, result: ApplyResult): void {
  if (values.json) {
    console.log(JSON.stringify({ plan, result }));
    return;
  }
  console.log(`${result.status}: ${result.completed.length} operations completed.`);
  if (result.status === "applied") console.log(`Validated: ${plan.validation.join("; ")}`);
  for (const error of result.errors) console.error(error);
  if (result.remaining.length)
    console.error(
      `${result.remaining.length} operations remain. Review a fresh plan before retrying.`,
    );
}

// Recipe lookup for `tamo add`: durable home recipes resolved through the
// one Core path. Every name — including effect-oxlint — is an ordinary
// durable recipe; there is no privileged built-in.
async function planRecipe(
  home: string,
  name: string,
  cwd: string,
): Promise<{ input?: CompositionInput; plan?: Plan; conflicts: string[] }> {
  const loaded = await loadAllRecipes(home);
  if (loaded.conflicts.length) return { conflicts: loaded.conflicts };
  const recipes = loaded.recipes;
  if (!recipes[name])
    throw new Error(
      `Unknown recipe: ${name}. Available: ${Object.keys(recipes).sort().join(", ")}`,
    );
  const input = recipeInput(cwd, recipes, name);
  const prepared = await planComposition(input);
  if (!prepared.plan) return { input, conflicts: prepared.conflicts };
  prepared.plan.inputs = [...prepared.plan.inputs, ...loaded.snapshots];
  return { input, plan: prepared.plan, conflicts: [] };
}

function recipeInput(
  cwd: string,
  recipes: Record<string, Recipe>,
  entry: string,
): CompositionInput {
  return {
    cwd,
    recipes,
    entry,
    invocation: [],
    handlers: [packageManifestHandler, oxlintConfigHandler],
    read,
  };
}

// Pack preparation is a plain promise; the confirmation and save happen inside
// main's Effect scope, so this only computes what would be saved.
async function preparePack(
  positionals: string[],
  values: {
    cwd?: string;
    force?: boolean;
    include?: string[];
    exclude?: string[];
  },
): Promise<{ home: string; target: string; recipe?: PackedRecipe; conflicts: string[] }> {
  if (positionals.length !== 2 || !positionals[1])
    throw new Error("Expected: tamo pack <recipe-name>. Use --help for supported options.");
  const name = positionals[1];
  const cwd = resolve(values.cwd ?? ".");
  const home = tamoHome();
  const target = recipeDir(home, name);

  const packed = await packRecipe(cwd, name, values.include ?? [], values.exclude ?? []);
  if (!packed.recipe) return { home, target, conflicts: packed.conflicts };
  if ((await entryType(target)) !== null && !values.force)
    return {
      home,
      target,
      conflicts: [
        ...packed.conflicts,
        `Recipe '${name}' already exists at ${target}; pass --force to replace it.`,
      ],
    };
  return { home, target, recipe: packed.recipe, conflicts: packed.conflicts };
}

const HELP = `tamo <command> [options]

Commands:
  inspect [--cwd path] [--json]
      Report the factual setup of the target project: package manager,
      dependencies, recognized config files, and limitations.
  pack <recipe-name> [--cwd path] [--include path]... [--exclude package]...
        [--force] [--dry-run] [--json] [--yes]
      Capture the reusable parts of the current project as a recipe under the
      Tamo home: the manifest as a native artifact plus explicitly included
      files. Secrets, generated output, dependency directories, caches, and
      lockfiles are never captured. The source project is never modified.
  create <dir> --recipe <name> [--cwd path] [--dry-run] [--json] [--yes]
      Create a new ordinary project from a saved recipe: its native artifacts
      at their original relative paths (the package name follows the new
      target), and a planned pnpm install. Existing non-empty targets are
      never overwritten; the result carries no Tamo metadata.
  add <recipe> [--cwd path] [--dry-run] [--json] [--yes]
      Apply reusable setup from a saved recipe to an existing project
      through recipes, artifact handlers, and Core planning. For example,
      an effect-oxlint recipe requires an existing pnpm project with Effect
      4.0.0-rc.112 and Oxlint 1.80.0.

Developer state (recipes) lives under the Tamo home directory
(default ~/.tamo); set TAMO_HOME to relocate it.

Run tamo <command> --help for command-specific usage and flags.`;

const HELP_INSPECT = `tamo inspect [--cwd <path>] [--json]

Report the factual setup of the target project: package manager,
dependencies, recognized config files, and limitations. Read-only.

Flags:
  --cwd <path>   Inspect the project at <path> (default: current directory).
  --json         Print the machine-readable inspection.`;

const HELP_PACK = `tamo pack <recipe-name> [--cwd <path>] [--include <path>]... [--exclude <package>]... [--force] [--dry-run] [--json] [--yes]

Capture the reusable parts of the current project as a recipe under the
Tamo home: the manifest as a native artifact (minus the source project's
name and version, which are project identity, not reusable setup) plus
explicitly included files. Secrets, generated output, dependency
directories, caches, and lockfiles are never captured. The source project
is never modified.

Flags:
  --cwd <path>        Pack the project at <path> (default: current directory).
  --include <path>    Also capture <path>; a directory expands into its
                      contained files. Repeatable.
  --exclude <package> Drop <package> from the captured manifest dependencies.
                      Repeatable.
  --force             Replace an existing recipe of the same name (repack
                      rebuilds from the current project).
  --dry-run           Show the recipe that would be saved without saving it.
  --json              Print machine-readable output.
  --yes               Save noninteractively (required outside a terminal).`;

const HELP_CREATE = `tamo create <dir> --recipe <name> [--cwd <path>] [--dry-run] [--json] [--yes]

Create a new ordinary project from a saved recipe: its native artifacts at
their original relative paths (the package name follows the new target),
and a planned pnpm install. Existing non-empty targets are never
overwritten; the result carries no Tamo metadata. Recipes that need an
upstream initializer run it first, then replan from fresh state.

Flags:
  --recipe <name>   The saved recipe to replay (required).
  --cwd <path>      Resolve <dir> relative to <path> (default: current
                    directory).
  --dry-run         Show the plan without creating anything.
  --json            Print machine-readable output.
  --yes             Apply noninteractively (required outside a terminal).`;

const HELP_ADD = `tamo add <recipe> [--cwd <path>] [--dry-run] [--json] [--yes]

Apply reusable setup from a saved recipe to an existing project through
recipes, artifact handlers, and Core planning. Plans are reviewed before
anything is applied; conflicts block with zero operations.

Flags:
  --cwd <path>   Apply to the project at <path> (default: current directory).
  --dry-run      Show the plan without changing anything.
  --json         Print machine-readable output.
  --yes          Apply noninteractively (required outside a terminal).`;

function helpFor(positionals: string[]): string {
  const [command] = positionals;
  if (command === "inspect") return HELP_INSPECT;
  if (command === "pack") return HELP_PACK;
  if (command === "create") return HELP_CREATE;
  if (command === "add") return HELP_ADD;
  return HELP;
}

const main = Effect.gen(function* () {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      json: { type: "boolean" },
      recipe: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(helpFor(positionals));
    return;
  }
  const [command] = positionals;
  if (command === "inspect") return yield* inspectCommand(values);
  if (command === "pack") return yield* packCommand(positionals, values);
  if (command === "create") return yield* createCommand(positionals, values);
  yield* addCommand(positionals, values);
});

function* inspectCommand(values: { cwd?: string; json?: boolean }) {
  const inspection = yield* Effect.promise(() => inspectProject(resolve(values.cwd ?? ".")));
  if (values.json) console.log(JSON.stringify({ inspection }));
  else showInspection(inspection);
}

function reportBlocked(conflicts: string[], json: boolean) {
  if (json) console.log(JSON.stringify({ status: "blocked", conflicts }));
  else for (const conflict of conflicts) console.error(`BLOCKED: ${conflict}`);
  process.exitCode = 1;
}

function* packCommand(
  positionals: string[],
  values: {
    cwd?: string;
    json?: boolean;
    "dry-run"?: boolean;
    yes?: boolean;
    force?: boolean;
    include?: string[];
    exclude?: string[];
  },
) {
  const prepared = yield* Effect.promise(() => preparePack(positionals, values));
  if (prepared.conflicts.length) {
    reportBlocked(prepared.conflicts, values.json ?? false);
    return;
  }
  // SAFETY: preparePack returns a recipe unless its conflicts are nonempty, which is handled above.
  const recipe = prepared.recipe!;
  if (!values.json) showRecipe(recipe, prepared.target);
  if (values["dry-run"]) {
    if (values.json) console.log(JSON.stringify({ recipe, status: "dry-run" }));
    return;
  }
  if (
    !values.yes &&
    !(yield* confirm(`Save recipe '${recipe.name}'?`, values.json ?? false, {
      recipe,
      target: prepared.target,
    }))
  )
    return;
  const path = yield* Effect.promise(() =>
    saveRecipe(prepared.home, recipe.name, recipe.artifacts),
  );
  if (values.json) console.log(JSON.stringify({ recipe, status: "saved", path }));
  else console.log(`Saved recipe '${recipe.name}' to ${path}`);
}

// Review one create plan: render it, stop honestly on dry-run, confirm
// otherwise. Mirrors the staged add review so both commands report staged
// plans the same way; the create dry-run keeps its `{ plan, status:
// "dry-run" }` shape, shows only the currently knowable plan, and never
// executes or fabricates the next stage.
async function reviewCreatePlan(
  plan: Plan,
  isPreparation: boolean,
  values: { json?: boolean; "dry-run"?: boolean; yes?: boolean },
  target: string,
): Promise<boolean> {
  const json = values.json ?? false;
  if (!json) showPlan(plan);
  if (values["dry-run"] ?? false) {
    if (json) console.log(JSON.stringify({ plan, status: "dry-run" }));
    return false;
  }
  if (values.yes ?? false) return true;
  // Entry point: confirmation from a plain callback runs as its own root
  // fiber with the Node services, mirroring the runtime boundary.
  return Effect.runPromise(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(
      confirm(`Apply this ${isPreparation ? "preparation " : ""}plan?`, json, {
        plan,
        target,
      }),
      nodeServices,
    ),
  );
}

// `tamo create <dir> --recipe <name>`: plan fresh, review, execute, and —
// when the reviewed plan requires it — plan again from fresh state and
// apply the final plan the same way, reusing the one-checkpoint
// orchestration shared with `add`. The initial guard rejects a populated
// target; the fresh stage-2 pass runs inside the same workflow after
// preparation intentionally populated it. Both stages render and report
// independently; a failed or declined stage stops the sequence.
function* createCommand(
  positionals: string[],
  values: { cwd?: string; json?: boolean; "dry-run"?: boolean; yes?: boolean; recipe?: string },
) {
  const targetArgument = positionals[1];
  const recipeName = values.recipe;
  if (positionals.length !== 2 || !targetArgument || !recipeName)
    throw new Error(
      "Expected: tamo create <dir> --recipe <name>. Use --help for supported options.",
    );
  const home = tamoHome();
  const cwd = resolve(values.cwd ?? ".");
  let freshPlans = 0;
  let target = resolve(cwd, targetArgument);
  const outcome = yield* Effect.promise(() =>
    applyRecipeWithReplan({
      planFresh: async () => {
        freshPlans++;
        const prepared = await planCreate(home, cwd, targetArgument, recipeName, {
          allowPopulatedTarget: freshPlans > 1,
        });
        target = prepared.target;
        return prepared;
      },
      review: (plan, isPreparation) => reviewCreatePlan(plan, isPreparation, values, target),
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyCreate(input, target),
    }),
  );
  if (outcome.status === "blocked") {
    reportBlocked(outcome.conflicts, values.json ?? false);
    return;
  }
  if (outcome.status === "aborted") return;
  if (outcome.status === "failed") {
    reportResult(values, outcome.plan, {
      status: "failed",
      completed: outcome.result.completed,
      remaining: outcome.result.remaining,
      errors: [...outcome.result.errors, ...outcome.verifyErrors],
    });
    process.exitCode = 1;
    return;
  }
  for (const stage of outcome.completed) reportResult(values, stage.plan, stage.result);
}

function* addCommand(
  positionals: string[],
  values: { cwd?: string; json?: boolean; "dry-run"?: boolean; yes?: boolean },
) {
  if (positionals.length !== 2 || positionals[0] !== "add" || !positionals[1])
    throw new Error("Expected: tamo add <recipe>. Use --help for supported options.");
  return yield* addRecipeCommand(positionals[1], values);
}

// Preserve the legacy `{ plan }` JSON shape for blocked adds: a reviewable
// plan with zero operations carrying the blocking conflicts.
function reportBlockedRecipePlan(
  cwd: string,
  name: string,
  conflicts: string[],
  json: boolean,
): void {
  const blocked: Plan = {
    subject: `recipe:${name}`,
    cwd,
    inputs: [],
    evidence: [],
    conflicts,
    operations: [],
    validation: ["Check contributed entries are present in the target artifacts"],
    requiresReplan: false,
  };
  if (!json) showPlan(blocked);
  else console.log(JSON.stringify({ plan: blocked }));
  process.exitCode = 1;
}

// Review one add plan: render it, stop honestly on dry-run, confirm
// otherwise. Runs as a plain promise so the staged orchestration can call
// it; confirmation runs its own root fiber with the Node services.
async function reviewAddPlan(
  plan: Plan,
  isPreparation: boolean,
  values: { json?: boolean; "dry-run"?: boolean; yes?: boolean },
): Promise<boolean> {
  const json = values.json ?? false;
  if (!json) showPlan(plan);
  if (values["dry-run"] ?? false) {
    if (json) console.log(JSON.stringify({ plan }));
    return false;
  }
  if (values.yes ?? false) return true;
  // Entry point: confirmation from a plain callback runs as its own root
  // fiber with the Node services, mirroring the runtime boundary.
  return Effect.runPromise(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide
    Effect.provide(
      confirm(`Apply this ${isPreparation ? "preparation " : ""}plan?`, json, { plan }),
      nodeServices,
    ),
  );
}

// `tamo add <recipe>`: plan fresh, review, execute, and — when the reviewed
// plan requires it — plan again from fresh state and apply the final plan
// the same way. Both stages render and report independently; a failed or
// declined stage stops the sequence.
function* addRecipeCommand(
  name: string,
  values: { cwd?: string; json?: boolean; "dry-run"?: boolean; yes?: boolean },
) {
  const cwd = resolve(values.cwd ?? ".");
  const home = tamoHome();
  const json = values.json ?? false;
  const outcome = yield* Effect.promise(() =>
    applyRecipeWithReplan({
      planFresh: () => planRecipe(home, name, cwd),
      review: (plan, isPreparation) => reviewAddPlan(plan, isPreparation, values),
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyComposition(input),
    }),
  );
  if (outcome.status === "blocked") {
    reportBlockedRecipePlan(cwd, name, outcome.conflicts, json);
    return;
  }
  if (outcome.status === "aborted") return;
  if (outcome.status === "failed") {
    reportResult(values, outcome.plan, {
      status: "failed",
      completed: outcome.result.completed,
      remaining: outcome.result.remaining,
      errors: [...outcome.result.errors, ...outcome.verifyErrors],
    });
    process.exitCode = 1;
    return;
  }
  for (const stage of outcome.completed) reportResult(values, stage.plan, stage.result);
}

// Interruption (Ctrl+C) unwinds the fiber so running installs are killed and
// temporary validation files are removed; it is not reported as a failure.
// Entry point: the CLI is the single place the Node services layer is provided.
// oxlint-disable-next-line effecttsgo/strict-effect-provide
const program = Effect.catchCause(Effect.provide(main, nodeServices), (cause) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.void
    : Effect.sync(() => {
        const error = Cause.squash(cause);
        const message = error instanceof Error ? error.message : String(error);
        if (process.argv.includes("--json"))
          console.log(JSON.stringify({ status: "failed", errors: [message] }));
        else console.error(message);
        process.exitCode = 1;
      }),
);

runMain({ disableErrorReporting: true })(program);
