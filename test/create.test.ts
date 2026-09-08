import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planCreate } from "../src/create.ts";
import { saveRecipe } from "../src/recipes.ts";
import { executePlan } from "../src/runtime.ts";

const root = resolve(".");

// The packed source project is named "source"; create must stamp the target
// name instead. Non-dependency fields ride along verbatim.
const manifestArtifact = JSON.stringify(
  {
    name: "source",
    private: true,
    type: "module",
    packageManager: "pnpm@10.11.0",
    scripts: { build: "tsc" },
    dependencies: {},
    devDependencies: {},
  },
  null,
  2,
);

const recipeArtifacts = [
  { path: "package.json", contents: `${manifestArtifact}\n` },
  { path: "tsconfig.json", contents: '{"compilerOptions":{"strict":true}}\n' },
  { path: "src/utils/cn.ts", contents: 'export const cn = (...p: string[]) => p.join("");\n' },
  { path: ".env.example", contents: "SECRET_KEY=\n" },
];

async function withHomeAndWorkspace(run: (home: string, workspace: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "tamo-create-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "tamo-create-ws-"));
  try {
    await saveRecipe(home, "sample", recipeArtifacts);
    await run(home, workspace);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
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

test("dry-run plans the project but creates nothing", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const dry = runCli(
      ["create", "new-app", "--recipe", "sample", "--cwd", workspace, "--json", "--dry-run"],
      home,
    );
    assert.equal(dry.code, 0, dry.stderr);
    const result = JSON.parse(dry.stdout);
    assert.equal(result.status, "dry-run");
    assert.equal(result.plan.subject, "recipe:sample");
    const kinds = result.plan.operations.map((operation: { kind: string }) => operation.kind);
    assert.deepEqual(kinds, ["write", "write", "write", "write", "command"]);
    const manifest = result.plan.operations.find((operation: { path: string }) =>
      operation.path.endsWith("package.json"),
    );
    assert.equal(JSON.parse(manifest.after).name, "new-app");
    assert.equal(await readdir(workspace).then((entries) => entries.length), 0);
  });
});

test("noninteractive create without --yes asks for confirmation and creates nothing", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const unconfirmed = runCli(
      ["create", "new-app", "--recipe", "sample", "--cwd", workspace, "--json"],
      home,
    );
    assert.equal(unconfirmed.code, 2);
    assert.equal(JSON.parse(unconfirmed.stdout).status, "confirmation-required");
    assert.equal(await readdir(workspace).then((entries) => entries.length), 0);
  });
});

test("create builds an ordinary project: manifest, native files, install, no Tamo metadata", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const created = runCli(
      ["create", "new-app", "--recipe", "sample", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(created.code, 0, created.stderr);
    const result = JSON.parse(created.stdout);
    assert.equal(result.result.status, "applied", JSON.stringify(result.result.errors));
    assert.equal(result.result.remaining.length, 0);

    const target = join(workspace, "new-app");
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    assert.deepEqual(manifest, {
      name: "new-app",
      private: true,
      type: "module",
      packageManager: "pnpm@10.11.0",
      scripts: { build: "tsc" },
      dependencies: {},
      devDependencies: {},
    });
    assert.equal(
      await readFile(join(target, "tsconfig.json"), "utf8"),
      recipeArtifacts[1]!.contents,
    );
    assert.equal(
      await readFile(join(target, "src/utils/cn.ts"), "utf8"),
      recipeArtifacts[2]!.contents,
    );
    assert.equal(
      await readFile(join(target, ".env.example"), "utf8"),
      recipeArtifacts[3]!.contents,
    );
    assert.notEqual(await readdir(join(target, "node_modules")).catch(() => null), null);
    assert.deepEqual((await readdir(target)).sort(), [
      ".env.example",
      "node_modules",
      "package.json",
      "pnpm-lock.yaml",
      "src",
      "tsconfig.json",
    ]);
  });
});

test("an existing non-empty target blocks instead of being overwritten", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const target = join(workspace, "new-app");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "user-file.txt"), "precious");
    const blocked = runCli(
      ["create", "new-app", "--recipe", "sample", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(blocked.code, 1);
    const result = JSON.parse(blocked.stdout);
    assert.equal(result.status, "blocked");
    assert.ok(result.conflicts[0].includes("not empty"));
    assert.equal(await readFile(join(target, "user-file.txt"), "utf8"), "precious");
  });
});

test("missing and invalid recipes block with actionable conflicts", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const missing = runCli(
      ["create", "app", "--recipe", "nope", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(missing.code, 1);
    const missingResult = JSON.parse(missing.stdout);
    assert.equal(missingResult.status, "blocked");
    assert.ok(missingResult.conflicts[0].includes("Unknown recipe: nope"));
    assert.ok(missingResult.conflicts[0].includes("sample"));

    await mkdir(join(home, "recipes", "broken"), { recursive: true });
    await writeFile(join(home, "recipes", "broken", "recipe.json"), "{ not json");
    const invalid = runCli(
      ["create", "app", "--recipe", "broken", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(invalid.code, 1);
    assert.equal(JSON.parse(invalid.stdout).status, "blocked");
    assert.ok(JSON.parse(invalid.stdout).conflicts[0].includes("not valid JSON"));
  });
});

test("denied artifact paths in a hand-edited recipe cannot replay", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await saveRecipe(home, "sneaky", [{ path: ".env", contents: "SECRET=1\n" }]);
    const blocked = runCli(
      ["create", "app", "--recipe", "sneaky", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(blocked.code, 1);
    const result = JSON.parse(blocked.stdout);
    assert.equal(result.status, "blocked");
    assert.ok(result.conflicts.join("\n").includes(".env is never captured"));
  });
});

test("creation never touches the source project the recipe was packed from", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const source = join(workspace, "source");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name: "source", packageManager: "pnpm@10.11.0" }),
    );
    await writeFile(join(source, "src", "index.ts"), "export {};\n");
    const listing = await readdir(source);
    const created = runCli(
      ["create", "new-app", "--recipe", "sample", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(await readdir(source), listing);
    assert.equal(await readFile(join(source, "src", "index.ts"), "utf8"), "export {};\n");
    assert.equal((await readdir(join(workspace, "new-app")).catch(() => null)) !== null, true);
  });
});

test("a stale recipe file fails the reviewed inputs before any mutation", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const artifactFile = join(home, "recipes", "sample", "artifacts", "tsconfig.json");
    const prepared = await planCreate(home, workspace, "new-app", "sample");
    assert.ok(prepared.plan && prepared.input);
    // Mutating the recipe between review and execution must invalidate the plan.
    await writeFile(artifactFile, "{}\n");
    const stale = await executePlan(prepared.plan);
    assert.equal(stale.status, "failed");
    assert.equal(stale.completed.length, 0);
    assert.ok(stale.errors.join(" ").includes("changed"));
    assert.equal(await readdir(join(workspace, "new-app")).catch(() => null), null);
  });
});

test("created package name matches the target, not the packed source", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const created = runCli(
      ["create", "billing-api", "--recipe", "sample", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(created.code, 0, created.stderr);
    const manifest = JSON.parse(
      await readFile(join(workspace, "billing-api", "package.json"), "utf8"),
    );
    assert.equal(manifest.name, "billing-api");
  });
});
