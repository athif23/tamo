import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parse } from "jsonc-parser";
import { seedEffectRecipe, versions } from "./effect-fixture.ts";
import { command } from "../src/runtime.ts";

const root = resolve(".");
const cwd = await mkdtemp(join(root, ".tamo-test-"));
async function run(executable: string, args: string[]) {
  const result = await command(executable, args, cwd);
  assert.equal(result.code, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  await cp(join(root, "test/fixtures/project"), cwd, { recursive: true });
  await run("pnpm", ["install", "--ignore-scripts"]);
  // effect-oxlint is an ordinary durable recipe: seed it into an isolated
  // home before the CLI runs. No built-in recipe participates.
  const effectHome = join(root, ".tamo-test-effect-home");
  await seedEffectRecipe(effectHome);
  await seedEffectRecipe(effectHome, "real-effect");
  const savedHome = process.env.TAMO_HOME;
  process.env.TAMO_HOME = effectHome;
  try {
    const configBefore = await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8");
    const manifestBefore = await readFile(join(cwd, "package.json"), "utf8");
    const lockBefore = await readFile(join(cwd, "pnpm-lock.yaml"), "utf8");
    const cli = [join(root, "src/cli.ts"), "add", "effect-oxlint", "--cwd", cwd, "--json"];
    const preview = JSON.parse(await run(process.execPath, [...cli, "--dry-run"]));
    assert.equal(preview.plan.subject, "recipe:effect-oxlint");
    assert.equal(preview.plan.conflicts.length, 0);
    assert.ok(preview.plan.operations.length > 0);
    assert.equal(await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8"), configBefore);
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), manifestBefore);
    assert.equal(await readFile(join(cwd, "pnpm-lock.yaml"), "utf8"), lockBefore);
    const unconfirmed = await command(process.execPath, cli, cwd);
    assert.equal(unconfirmed.code, 2);
    assert.equal(JSON.parse(unconfirmed.stdout).status, "confirmation-required");
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), manifestBefore);
    const applied = JSON.parse(await run(process.execPath, [...cli, "--yes"]));
    assert.equal(applied.result.status, "applied");
    const scriptLint = JSON.parse(
      await run("pnpm", ["exec", "oxlint", "--format=json", "scripts/provided.ts"]),
    );
    assert.ok(scriptLint.number_of_files > 0);
    assert.equal(
      scriptLint.diagnostics.some(
        (d: { code: string }) => d.code === "effecttsgo(strict-effect-provide)",
      ),
      false,
    );
    const after = await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8");
    assert.ok(after.includes("// This project's choices must survive Tamo."));
    assert.equal(parse(after).rules["unicorn/no-null"], "off");
    assert.equal(parse(after).overrides[0].rules["eslint/no-var"], "error");
    const second = JSON.parse(await run(process.execPath, [...cli, "--dry-run"]));
    assert.deepEqual(second.plan.operations, []);
    // Durable proof: the same production behavior under a second durable
    // name plans identically on the same real state — prerequisite/version
    // checks, patch-state detection, tracked inputs, and finalize commands
    // included.
    const durableCli = [join(root, "src/cli.ts"), "add", "real-effect", "--cwd", cwd, "--json"];
    const durablePreview = JSON.parse(await run(process.execPath, [...durableCli, "--dry-run"]));
    assert.equal(durablePreview.plan.conflicts.length, 0);
    assert.deepEqual(durablePreview.plan.operations, []);
    const durableApplied = JSON.parse(await run(process.execPath, [...durableCli, "--yes"]));
    assert.equal(durableApplied.result.status, "applied");
    assert.deepEqual(durableApplied.plan.operations, []);
    await run("pnpm", ["install", "--offline", "--frozen-lockfile"]);
    const reinstalled = JSON.parse(await run(process.execPath, [...cli, "--yes"]));
    assert.equal(reinstalled.result.status, "applied");
    assert.deepEqual(reinstalled.plan.operations, []);
    assert.equal(
      (await readdir(cwd)).some((name) => name.startsWith(".tamo-validation-")),
      false,
    );
    console.log(
      "Integration passed: dry-run, install, patch, real rule probes, preservation, reinstall and idempotency.",
    );
  } finally {
    if (savedHome === undefined) delete process.env.TAMO_HOME;
    else process.env.TAMO_HOME = savedHome;
    await rm(effectHome, { recursive: true, force: true });
  }

  // Round trip: pack a sample project as a durable recipe, then create a new
  // ordinary project from it through Core planning with a real install. The
  // home is forced into the environment so CLI children never touch the real one.
  const home = join(root, ".tamo-test-home");
  process.env.TAMO_HOME = home;
  const source = join(home, "source");
  await mkdir(join(source, "src/utils"), { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify(
      {
        name: "sample",
        private: true,
        type: "module",
        packageManager: "pnpm@10.11.0",
        scripts: { build: "tsc" },
        dependencies: { effect: versions.effect },
        devDependencies: { "@types/node": "^24.0.0" },
      },
      null,
      2,
    ),
  );
  await writeFile(join(source, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
  await writeFile(
    join(source, ".oxlintrc.jsonc"),
    '// Source choices survive.\n{"rules":{"no-var":"error"}}\n',
  );
  await writeFile(
    join(source, "src/utils/cn.ts"),
    'export const cn = (...p: string[]) => p.join(" ");\n',
  );
  await writeFile(
    join(source, "src/utils/result.ts"),
    "export type Result<T> = { ok: true; value: T };\n",
  );
  await writeFile(join(source, ".env"), "SECRET=real\n");
  await writeFile(join(source, ".env.example"), "SECRET=\n");
  const tamoCli = [join(root, "src/cli.ts")];
  const packed = JSON.parse(
    await run(process.execPath, [
      ...tamoCli,
      "pack",
      "sample",
      "--cwd",
      source,
      "--json",
      "--yes",
      "--include",
      "tsconfig.json",
      "--include",
      ".oxlintrc.jsonc",
      "--include",
      "src/utils",
      "--include",
      ".env.example",
    ]),
  );
  assert.equal(packed.status, "saved", packed.stderr ?? JSON.stringify(packed));
  assert.deepEqual(
    packed.recipe.artifacts.map((file: { path: string }) => file.path),
    [
      "package.json",
      "tsconfig.json",
      ".oxlintrc.jsonc",
      "src/utils/cn.ts",
      "src/utils/result.ts",
      ".env.example",
    ],
  );
  const sourceListing = await readdir(source);
  const created = JSON.parse(
    await run(process.execPath, [
      ...tamoCli,
      "create",
      "replay",
      "--recipe",
      "sample",
      "--cwd",
      home,
      "--json",
      "--yes",
    ]),
  );
  assert.equal(created.result.status, "applied", JSON.stringify(created.result.errors));
  const target = join(home, "replay");
  const replayManifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
  assert.deepEqual(replayManifest, {
    name: "replay",
    private: true,
    type: "module",
    packageManager: "pnpm@10.11.0",
    scripts: { build: "tsc" },
    dependencies: { effect: versions.effect },
    devDependencies: { "@types/node": "^24.0.0" },
  });
  assert.equal(
    await readFile(join(target, ".oxlintrc.jsonc"), "utf8"),
    '// Source choices survive.\n{"rules":{"no-var":"error"}}\n',
  );
  assert.equal(
    await readFile(join(target, "src/utils/cn.ts"), "utf8"),
    'export const cn = (...p: string[]) => p.join(" ");\n',
  );
  assert.equal(await readFile(join(target, ".env.example"), "utf8"), "SECRET=\n");
  assert.equal((await readdir(target)).includes(".env"), false);
  assert.equal(
    (await readdir(join(target, "node_modules/effect")).catch(() => null)) !== null,
    true,
  );
  assert.equal((await readdir(target)).includes("tamo.json"), false);
  assert.deepEqual(await readdir(source), sourceListing);
  console.log("Integration passed: pack → recipe → create round trip with real install.");
} finally {
  assert.ok(cwd.startsWith(join(root, ".tamo-test-")));
  await rm(cwd, { recursive: true, force: true });
  await rm(join(root, ".tamo-test-home"), { recursive: true, force: true });
}
