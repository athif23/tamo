// Real-ecosystem create smoke for staged `tamo create` (manual entry
// point, NOT part of the deterministic suite): the official shadcn CLI
// scaffolds the absent target as a prepare command run from the existing
// parent workspace, then a fresh stage-2 create plan merges durable recipe
// contributions into the generated project through the existing handlers.
// The existing add-style smoke stays unchanged; this file drives the public
// create entry point (`tamo create <name> --recipe web`) instead.
//
// Run exactly: pnpm test:smoke-shadcn-create   (needs network; cleans its temp dirs)
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { planComposition } from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { loadAllRecipes } from "../src/recipes.ts";
import { read } from "../src/runtime.ts";
import type { Plan } from "../src/plan.ts";
import { SHADCN_PROJECT, SHADCN_VERSION } from "./shadcn-smoke.ts";

const root = resolve(".");
const handlers = [packageManifestHandler, oxlintConfigHandler];

// The prepare behavior derives the existing parent workspace and the child
// name from the create target itself: no shadcn-specific target logic in
// Core or create, and no hardcoded project name in the recipe.
function shadcnAppBehaviorSource(): string {
  const smokeModule = JSON.stringify(
    pathToFileURL(fileURLToPath(new URL("./shadcn-smoke.ts", import.meta.url))).href,
  );
  return `\
import { SHADCN_VERSION } from ${smokeModule};
import { basename, dirname } from "node:path";
export default {
  prepare: async (context) => {
    if ((await context.read("components.json")) !== null)
      return { conflicts: [], evidence: ["shadcn output already present"], operations: [] };
    const workspace = dirname(context.cwd);
    const name = basename(context.cwd);
    const entry = process.env.npm_execpath;
    if (!entry || !/pnpm\\.(?:c?js)$/i.test(entry))
      return {
        conflicts: ["Run the shadcn create smoke via pnpm (pnpm test:smoke-shadcn-create) so its pnpm executable is known."],
        evidence: [],
        operations: [],
      };
    return {
      conflicts: [],
      evidence: ["target has no components.json; planning shadcn initialization first"],
      operations: [
        {
          kind: "command",
          executable: process.execPath,
          args: [
            entry, "dlx", "shadcn@" + SHADCN_VERSION, "init",
            "--template", "vite", "--yes", "--base", "base", "--preset", "nova",
            "--name", name, "--no-monorepo", "--no-rtl", "--no-pointer", "--no-reinstall",
            "--cwd", workspace,
          ],
          cwd: workspace,
          purpose: "Initialize a Vite project with shadcn@" + SHADCN_VERSION,
        },
      ],
    };
  },
};
`;
}

async function writeRecipe(
  home: string,
  name: string,
  options: { recipeJson?: string; behaviorMjs?: string; artifacts?: Record<string, string> },
): Promise<void> {
  const dir = join(home, "recipes", name);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await writeFile(join(dir, "recipe.json"), options.recipeJson ?? "{}\n");
  for (const [path, contents] of Object.entries(options.artifacts ?? {})) {
    const absolute = join(dir, "artifacts", path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  if (options.behaviorMjs !== undefined)
    await writeFile(join(dir, "behavior.mjs"), options.behaviorMjs);
}

function fail(message: string): never {
  throw new Error(`SMOKE FAIL: ${message}`);
}

function manifestOf(contents: string): Record<string, unknown> {
  // SAFETY: package.json bytes are parsed as the JSON objects they must be.
  return JSON.parse(contents) as Record<string, unknown>;
}

type StageRecord = { plan: Plan; result?: { status: string; errors?: unknown } };

function checkStages(records: StageRecord[], parent: string): void {
  if (records.length !== 2) fail(`expected two stage records, saw ${records.length}`);
  // SAFETY: the length check above established exactly two stage records.
  const [first, second] = records as [StageRecord, StageRecord];
  if (!first.plan.requiresReplan) fail("first plan must require a replan");
  if (first.plan.operations.length !== 1 || first.plan.operations[0]!.kind !== "command")
    fail("first plan must hold only the initializer command");
  const initializer = first.plan.operations[0]!;
  if (initializer.kind !== "command" || initializer.cwd !== parent)
    fail("initializer must run from the existing parent workspace");
  if (first.result?.status !== "applied") fail("first stage did not apply");
  if (second.plan.requiresReplan) fail("second plan must be final");
  const kinds = second.plan.operations.map((operation) => operation.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(["write", "write", "command"]))
    fail(`second plan holds ${JSON.stringify(kinds)}, expected two writes plus install`);
  if (second.result?.status !== "applied")
    fail(`second stage did not apply: ${JSON.stringify(second.result?.errors)}`);
}

async function checkGenerated(target: string): Promise<void> {
  const createdTop = (await readdir(target)).filter((name) => name !== "node_modules").sort();
  console.log(`generated top level: ${createdTop.join(", ")}`);
  for (const required of ["package.json", "components.json"])
    if (!createdTop.includes(required)) fail(`shadcn did not create ${required}`);
  const manifest = manifestOf(await readFile(join(target, "package.json"), "utf8"));
  // SAFETY: the generated manifest carries dependency/script maps by template construction.
  const sections = manifest as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  const expected: Array<[Record<string, string>, string]> = [
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
  const components = manifestOf(await readFile(join(target, "components.json"), "utf8"));
  // SAFETY: components.json carries an aliases map by shadcn construction.
  const aliases = components.aliases as Record<string, string>;
  if (aliases.components !== "@/components") fail("components.json aliases changed");
  const css = await readFile(join(target, "src", "index.css"), "utf8");
  if (!css.includes('@import "tailwindcss"')) fail("generated CSS entry lost");
}

async function main(): Promise<void> {
  console.log(`shadcn@${SHADCN_VERSION} create smoke`);
  const parent = await mkdtemp(join(tmpdir(), "tamo-shadcn-create-"));
  const home = await mkdtemp(join(tmpdir(), "tamo-shadcn-create-home-"));
  const target = join(parent, SHADCN_PROJECT);
  try {
    await writeRecipe(home, "shadcn-app", {
      behaviorMjs: shadcnAppBehaviorSource(),
      artifacts: {
        "package.json": JSON.stringify({ devDependencies: { vitest: "^3.2.4" } }),
        ".oxlintrc.jsonc": JSON.stringify({ rules: { "no-debugger": "error" } }),
      },
    });
    await writeRecipe(home, "smoke-extra", {
      artifacts: {
        "package.json": JSON.stringify({
          dependencies: { clsx: "^2.1.1" },
          scripts: { test: "vitest run" },
        }),
      },
    });
    await writeRecipe(home, "web", {
      recipeJson: JSON.stringify({
        includes: [{ recipe: "shadcn-app" }, { recipe: "smoke-extra" }],
      }),
    });

    const created = spawnSync(
      process.execPath,
      [
        join(root, "src/cli.ts"),
        "create",
        SHADCN_PROJECT,
        "--recipe",
        "web",
        "--cwd",
        parent,
        "--json",
        "--yes",
      ],
      { cwd: root, env: { ...process.env, TAMO_HOME: home }, encoding: "utf8" },
    );
    if (created.status !== 0)
      fail(`tamo create exited ${created.status}\n${created.stdout}\n${created.stderr}`);
    const records = created.stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    checkStages(records, parent);
    await checkGenerated(target);

    const loaded = await loadAllRecipes(home);
    if (loaded.conflicts.length) fail(loaded.conflicts.join("; "));
    const settled = await planComposition({
      cwd: target,
      recipes: loaded.recipes,
      entry: "web",
      invocation: [],
      handlers,
      read,
    });
    if (settled.conflicts.length) fail(`settled replan conflicts: ${settled.conflicts.join("; ")}`);
    if ((settled.plan?.operations ?? []).length) fail("settled replan proposes operations");
    if (settled.plan?.requiresReplan) fail("settled state must not require a replan");
    console.log("SMOKE PASS: shadcn create + combined contributions + idempotent replan");
  } finally {
    for (const dir of [parent, home]) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        console.warn(`cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
      }
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
