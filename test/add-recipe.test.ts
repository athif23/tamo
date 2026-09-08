import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedEffectRecipe, versions } from "./effect-fixture.ts";
import type { Plan } from "../src/plan.ts";

const root = resolve(".");
const fixtureConfig =
  '// Keep this comment\n{ "rules": { "eslint/no-debugger": "error" }, "overrides": [{ "files": ["*.js"], "rules": { "eslint/no-var": "error" } }] }';

async function withAddProject(
  run: (cwd: string, home: string) => Promise<void>,
  config = fixtureConfig,
) {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-add-recipe-"));
  const home = await mkdtemp(join(tmpdir(), "tamo-add-home-"));
  try {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "sample",
        packageManager: "pnpm@10.11.0",
        dependencies: { effect: versions.effect },
        devDependencies: { oxlint: versions.oxlint },
        scripts: { prepare: "node setup.mjs" },
      }),
    );
    await writeFile(join(cwd, ".oxlintrc.jsonc"), config);
    for (const name of ["effect", "oxlint"]) {
      await mkdir(join(cwd, "node_modules", name), { recursive: true });
      await writeFile(
        join(cwd, "node_modules", name, "package.json"),
        JSON.stringify({ version: versions[name] }),
      );
    }
    // effect-oxlint is an ordinary durable recipe, not a built-in: seed it
    // into the isolated test home before the CLI runs.
    await seedEffectRecipe(home);
    await run(cwd, home);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

function runCli(args: string[], home: string) {
  const result = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, TAMO_HOME: home },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function writes(plan: Plan) {
  return plan.operations
    .filter((operation) => operation.kind === "write")
    .map((operation) =>
      operation.kind === "write"
        ? { path: operation.path, before: operation.before, after: operation.after }
        : null,
    )
    .sort((a, b) => a!.path.localeCompare(b!.path));
}

function commands(plan: Plan) {
  return plan.operations
    .filter((operation) => operation.kind === "command")
    .map((operation) => (operation.kind === "command" ? { args: operation.args } : null));
}

test("dry-run goes through the recipe path with additive semantics", async () => {
  await withAddProject(async (cwd, home) => {
    const configBefore = await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8");
    const manifestBefore = await readFile(join(cwd, "package.json"), "utf8");

    const dry = runCli(["add", "effect-oxlint", "--cwd", cwd, "--json", "--dry-run"], home);
    assert.equal(dry.code, 0, dry.stderr);
    const preview = JSON.parse(dry.stdout);
    assert.equal(preview.plan.subject, "recipe:effect-oxlint");
    assert.deepEqual(preview.plan.conflicts, []);
    assert.deepEqual(commands(preview.plan), [
      { args: ["install", "--ignore-scripts"] },
      { args: ["exec", "effect-tsgo", "patch", "--no-typescript", "--oxlint"] },
    ]);

    const manifest = writes(preview.plan).find((write) => write!.path.endsWith("package.json"))!;
    assert.equal(
      JSON.parse(manifest!.after).scripts.prepare,
      "node setup.mjs && effect-tsgo patch --no-typescript --oxlint",
    );
    const config = writes(preview.plan).find((write) => write!.path.endsWith(".jsonc"))!;
    assert.ok(config!.after.startsWith("// Keep this comment"));

    // Dry-run mutates nothing.
    assert.equal(await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8"), configBefore);
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), manifestBefore);
  });
});

test("blocking CLI states propose no operations and keep exit-code semantics", async () => {
  await withAddProject(async (cwd, home) => {
    const configBefore = await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8");
    const blocked = runCli(["add", "effect-oxlint", "--cwd", cwd, "--json", "--dry-run"], home);
    assert.equal(blocked.code, 1, blocked.stdout);
    const result = JSON.parse(blocked.stdout);
    assert.ok(result.plan.conflicts.length > 0);
    assert.deepEqual(result.plan.operations, []);
    assert.equal(await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8"), configBefore);
  }, '{"rules":{"effecttsgo/strict-effect-provide":"off"}}');
});

test("noninteractive add without --yes asks for confirmation and changes nothing", async () => {
  await withAddProject(async (cwd, home) => {
    const manifestBefore = await readFile(join(cwd, "package.json"), "utf8");
    const unconfirmed = runCli(["add", "effect-oxlint", "--cwd", cwd, "--json"], home);
    assert.equal(unconfirmed.code, 2);
    assert.equal(JSON.parse(unconfirmed.stdout).status, "confirmation-required");
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), manifestBefore);
  });
});

test("unknown recipes fail as a normal not-found error", async () => {
  await withAddProject(async (cwd, home) => {
    const manifestBefore = await readFile(join(cwd, "package.json"), "utf8");
    const missing = runCli(["add", "nope", "--cwd", cwd, "--json"], home);
    assert.equal(missing.code, 1);
    const result = JSON.parse(missing.stdout);
    assert.equal(result.status, "failed");
    assert.ok(result.errors.join("\n").includes("Unknown recipe: nope"));
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), manifestBefore);
  });
});

test("production code carries no Extension or feature-registry remnants", async () => {
  for (const file of [
    "src/cli.ts",
    "src/compose.ts",
    "src/create.ts",
    "src/pack.ts",
    "src/plan.ts",
    "src/recipes.ts",
    "src/runtime.ts",
  ]) {
    const source = await readFile(join(root, file), "utf8");
    assert.ok(!source.includes("Extension"), `${file} must not mention Extension`);
    assert.ok(!source.includes("features/"), `${file} must not reference features/`);
  }
  const cli = await readFile(join(root, "src/cli.ts"), "utf8");
  assert.ok(!cli.includes("effectOxlintRecipe"), "no built-in recipe injection remains");
  assert.ok(!cli.includes("shadows the built-in"), "no reserved-name shadowing remains");
  assert.ok(cli.includes("loadAllRecipes"), "add must resolve durable home recipes");
  assert.ok(cli.includes("executePlan"), "apply must go through executePlan");
  assert.ok(cli.includes("verifyComposition"), "validation must go through Core verification");
});
