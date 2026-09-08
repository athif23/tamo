// Real-ecosystem smoke for the prepare -> replan mechanism (manual entry
// point, NOT part of the deterministic suite): the official shadcn CLI
// initializes a Vite project as a RecipeBehavior.prepare command, then a
// fresh replan merges experimental recipe contributions into the generated
// state through the existing handlers. No Core/handler changes, no durable
// recipe, no product surface: everything experiment-specific lives here.
//
// Run exactly: pnpm test:smoke-shadcn   (needs network; cleans its temp dir)
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  applyRecipeWithReplan,
  planComposition,
  verifyComposition,
  type CompositionInput,
  type Recipe,
  type RecipeBehavior,
} from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { executePlan, read } from "../src/runtime.ts";
import type { Plan } from "../src/plan.ts";

// Pinned upstream: exact CLI version from the 2026-09-04 npm release.
export const SHADCN_VERSION = "4.21.0";
export const SHADCN_PROJECT = "smoke-vite";

const handlers = [packageManifestHandler, oxlintConfigHandler];

// The exact noninteractive invocation, probed flag-by-flag against the
// pinned CLI: every remaining prompt has a documented flag, so stdin stays
// closed (the runtime spawns with stdin ignored).
export function shadcnInitArgs(workspace: string): string[] {
  return [
    "dlx",
    `shadcn@${SHADCN_VERSION}`,
    "init",
    "--template",
    "vite",
    "--yes",
    "--base",
    "base",
    "--preset",
    "nova",
    "--name",
    SHADCN_PROJECT,
    "--no-monorepo",
    "--no-rtl",
    "--no-pointer",
    "--no-reinstall",
    "--cwd",
    workspace,
  ];
}

// pnpm is the documented dlx runner; the JS entry runs directly on this
// machine's Node exactly like the runtime's own pnpm handling. This stays
// experiment-local: no product code learns about shadcn.
export function pnpmEntry(): string {
  const entry = process.env.npm_execpath;
  if (!entry || !/pnpm\.(?:c?js)$/i.test(entry))
    throw new Error(
      "Run the shadcn smoke via pnpm (pnpm test:smoke-shadcn) so its pnpm executable is known.",
    );
  return entry;
}

// The initializer scaffolds a NAMED subdirectory, so the command runs in
// the workspace while Tamo plans against the future project root. The
// gate is the canonical shadcn marker: actual generated state, no command
// history metadata.
export function shadcnPrepare(
  executable: string,
  args: string[],
  workspace: string,
): RecipeBehavior {
  return {
    prepare: async (context) => {
      if ((await context.read("components.json")) !== null)
        return {
          conflicts: [],
          evidence: ["shadcn output already present"],
          operations: [],
        };
      return {
        conflicts: [],
        evidence: ["target has no components.json; planning shadcn initialization first"],
        operations: [
          {
            kind: "command",
            executable,
            args,
            cwd: workspace,
            purpose: `Initialize a Vite project with shadcn@${SHADCN_VERSION}`,
          },
        ],
      };
    },
  };
}

// A second behavior-bearing recipe proving multi-behavior coexistence in
// the real flow: silent prepare, evidence-only post-artifact plan, and a
// verifier asserting its own instance identity. No artifacts, so the
// two-write final plan shape is unchanged.
function smokeSidecar(): RecipeBehavior {
  return {
    prepare: async () => ({
      conflicts: [],
      evidence: ["sidecar needs no preparation"],
      operations: [],
    }),
    finalize: async () => ({
      conflicts: [],
      evidence: ["sidecar observed the applied target"],
      operations: [],
    }),
    verify: async (context) => {
      if (context.instance.join(" > ") !== "web > smoke-sidecar")
        return [`sidecar verifier saw foreign instance [${context.instance.join(" > ")}]`];
      if (context.artifacts.length !== 0) return ["sidecar verifier saw artifacts it does not own"];
      return [];
    },
  };
}

// Parent web over one behavior-bearing child (shadcn init + its own package
// and Oxlint contributions), a second behavior-bearing sidecar, and one
// sibling package contributor. All values are disjoint from the generated
// template by construction; any drift in a future CLI release must surface
// as a conflict, not a silent overwrite.
export function shadcnExperimentRecipes(
  executable: string,
  args: string[],
  workspace: string,
): Record<string, Recipe> {
  return {
    "shadcn-app": {
      name: "shadcn-app",
      behavior: shadcnPrepare(executable, args, workspace),
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({ devDependencies: { vitest: "^3.2.4" } }),
        },
        {
          path: ".oxlintrc.jsonc",
          contents: JSON.stringify({ rules: { "no-debugger": "error" } }),
        },
      ],
    },
    "smoke-extra": {
      name: "smoke-extra",
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({
            dependencies: { clsx: "^2.1.1" },
            scripts: { test: "vitest run" },
          }),
        },
      ],
    },
    "smoke-sidecar": { name: "smoke-sidecar", behavior: smokeSidecar(), artifacts: [] },
    web: {
      name: "web",
      artifacts: [],
      includes: [{ recipe: "shadcn-app" }, { recipe: "smoke-sidecar" }, { recipe: "smoke-extra" }],
    },
  };
}

function fail(message: string): never {
  throw new Error(`SMOKE FAIL: ${message}`);
}

function checkStages(outcome: { status: string; completed?: { plan: Plan }[] }): void {
  if (outcome.status !== "applied") fail(`outcome is ${outcome.status}`);
  if ((outcome.completed ?? []).length !== 2) fail("expected exactly two completed stages");
  const first = outcome.completed![0]!;
  const second = outcome.completed![1]!;
  if (!first.plan.requiresReplan) fail("first plan must require a replan");
  if (first.plan.operations.length !== 1 || first.plan.operations[0]!.kind !== "command")
    fail("first plan must hold only the initializer command");
  if (second.plan.requiresReplan) fail("second plan must be final");
  const writes = second.plan.operations.filter((operation) => operation.kind === "write");
  if (writes.length !== second.plan.operations.length || writes.length !== 2)
    fail(`second plan must hold only artifact writes, saw ${second.plan.operations.length}`);
  if (!second.plan.evidence.some((line) => line.includes("sidecar observed")))
    fail("commandless sidecar evidence missing from the final plan");
}

async function checkGenerated(project: string): Promise<void> {
  const created = (await readdir(project)).filter((name) => name !== "node_modules").sort();
  console.log(`generated top level: ${created.join(", ")}`);
  for (const required of ["package.json", "components.json"])
    if (!created.includes(required)) fail(`shadcn did not create ${required}`);
  // The template's installer follows the detected package manager: npm
  // writes package-lock.json, pnpm (as here, via pnpm dlx) writes
  // pnpm-lock.yaml. Either proves dependency installation ran.
  if (
    !created.includes("package-lock.json") &&
    !created.includes("pnpm-lock.yaml") &&
    !created.includes("bun.lock")
  )
    fail("shadcn created no lockfile");

  const manifest = manifestOf(await readFile(join(project, "package.json"), "utf8"));
  // SAFETY: the generated manifest carries dependency/script maps by template construction.
  const sections = manifest as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  const expected: [Record<string, string>, string][] = [
    [sections.dependencies, "react"],
    [sections.dependencies, "tailwindcss"],
    [sections.dependencies, "clsx"],
    [sections.devDependencies, "vite"],
    [sections.devDependencies, "vitest"],
  ];
  for (const [section, name] of expected)
    if (section[name] === undefined) fail(`package.json lost ${name}`);
  if (sections.scripts.test !== "vitest run") fail("recipe script contribution missing");
  if (sections.scripts.build === undefined) fail("generated build script lost");
  if (manifest.name !== SHADCN_PROJECT) fail("generated project name changed");

  const components = manifestOf(await readFile(join(project, "components.json"), "utf8"));
  // SAFETY: components.json carries an aliases map by shadcn construction.
  const aliases = components.aliases as Record<string, string>;
  if (aliases.components !== "@/components") fail("components.json aliases changed");
  const css = await readFile(join(project, "src", "index.css"), "utf8");
  if (!css.includes('@import "tailwindcss"')) fail("generated CSS entry lost");
}

function manifestOf(contents: string): Record<string, unknown> {
  // SAFETY: package.json bytes are parsed as the JSON objects they must be.
  return JSON.parse(contents) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const entry = pnpmEntry();
  const workspace = await mkdtemp(join(tmpdir(), "tamo-shadcn-"));
  const project = join(workspace, SHADCN_PROJECT);
  const args = shadcnInitArgs(workspace);
  const recipes = shadcnExperimentRecipes(process.execPath, [entry, ...args], workspace);
  const input: CompositionInput = {
    cwd: project,
    recipes,
    entry: "web",
    invocation: [],
    handlers,
    read,
  };
  console.log(`workspace: ${workspace}`);
  try {
    const outcome = await applyRecipeWithReplan({
      planFresh: async () => {
        const prepared = await planComposition(input);
        return { input, plan: prepared.plan, conflicts: prepared.conflicts };
      },
      review: async (plan: Plan, isPreparation: boolean) => {
        console.log(
          `--- ${isPreparation ? "preparation" : "final"} plan (requiresReplan=${plan.requiresReplan}):`,
        );
        for (const operation of plan.operations)
          console.log(
            operation.kind === "command"
              ? `command: ${operation.executable} ${operation.args.join(" ")}`
              : `write: ${operation.path}`,
          );
        return true;
      },
      execute: (plan: Plan) => executePlan(plan),
      verify: (planInput: CompositionInput) => verifyComposition(planInput),
    });
    checkStages(outcome);
    await checkGenerated(project);

    const replan = await planComposition(input);
    if (replan.conflicts.length)
      fail(`idempotent replan conflicts: ${replan.conflicts.join("; ")}`);
    if ((replan.plan?.operations ?? []).length) fail("idempotent replan proposes operations");
    if (replan.plan?.requiresReplan) fail("settled state must not require a replan");
    console.log("SMOKE PASS: shadcn init + combined contributions + idempotent replan");
  } finally {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (error) {
      console.warn(`cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
