import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planCreate } from "../src/create.ts";
import { savePreset, validatePreset } from "../src/preset.ts";
import { execute } from "../src/runtime.ts";

const root = resolve(".");

const preset = {
  name: "sample",
  packageManager: "pnpm@10.11.0",
  dependencies: {},
  devDependencies: {},
  files: [
    { path: "tsconfig.json", contents: '{"compilerOptions":{"strict":true}}\n' },
    { path: "src/utils/cn.ts", contents: 'export const cn = (...p: string[]) => p.join("");\n' },
    { path: ".env.example", contents: "SECRET_KEY=\n" },
  ],
};

async function withHomeAndWorkspace(run: (home: string, workspace: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "tamo-create-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "tamo-create-ws-"));
  try {
    await savePreset(home, validatePreset(preset, "test"));
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
      ["create", "new-app", "--preset", "sample", "--cwd", workspace, "--json", "--dry-run"],
      home,
    );
    assert.equal(dry.code, 0, dry.stderr);
    const result = JSON.parse(dry.stdout);
    assert.equal(result.status, "dry-run");
    assert.equal(result.plan.extension, "create");
    const kinds = result.plan.operations.map((operation: { kind: string }) => operation.kind);
    assert.deepEqual(kinds, ["write", "write", "write", "write", "command"]);
    assert.equal(await readdir(workspace).then((entries) => entries.length), 0);
  });
});

test("noninteractive create without --yes asks for confirmation and creates nothing", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const unconfirmed = runCli(
      ["create", "new-app", "--preset", "sample", "--cwd", workspace, "--json"],
      home,
    );
    assert.equal(unconfirmed.code, 2);
    assert.equal(JSON.parse(unconfirmed.stdout).status, "confirmation-required");
    assert.equal(await readdir(workspace).then((entries) => entries.length), 0);
  });
});

test("create builds an ordinary project: manifest, seeds, install, no Tamo metadata", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const created = runCli(
      ["create", "new-app", "--preset", "sample", "--cwd", workspace, "--json", "--yes"],
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
      packageManager: "pnpm@10.11.0",
    });
    assert.equal(await readFile(join(target, "tsconfig.json"), "utf8"), preset.files[0].contents);
    assert.equal(await readFile(join(target, "src/utils/cn.ts"), "utf8"), preset.files[1].contents);
    assert.equal(await readFile(join(target, ".env.example"), "utf8"), preset.files[2].contents);
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
      ["create", "new-app", "--preset", "sample", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(blocked.code, 1);
    const result = JSON.parse(blocked.stdout);
    assert.equal(result.status, "blocked");
    assert.ok(result.conflicts[0].includes("not empty"));
    assert.equal(await readFile(join(target, "user-file.txt"), "utf8"), "precious");
  });
});

test("missing and invalid presets block with actionable conflicts", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const missing = runCli(
      ["create", "app", "--preset", "nope", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(missing.code, 1);
    const missingResult = JSON.parse(missing.stdout);
    assert.equal(missingResult.status, "blocked");
    assert.ok(missingResult.conflicts[0].includes("Unknown preset: nope"));
    assert.ok(missingResult.conflicts[0].includes("sample"));

    await writeFile(join(home, "presets", "broken.json"), "{ not json");
    const invalid = runCli(
      ["create", "app", "--preset", "broken", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(invalid.code, 1);
    assert.equal(JSON.parse(invalid.stdout).status, "blocked");
    assert.ok(JSON.parse(invalid.stdout).conflicts[0].includes("not valid JSON"));
  });
});

test("denied seed paths in a hand-edited preset cannot replay", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await savePreset(
      home,
      validatePreset(
        { ...preset, name: "sneaky", files: [{ path: ".env", contents: "SECRET=1\n" }] },
        "test",
      ),
    );
    const blocked = runCli(
      ["create", "app", "--preset", "sneaky", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(blocked.code, 1);
    const result = JSON.parse(blocked.stdout);
    assert.equal(result.status, "blocked");
    assert.ok(result.conflicts.join("\n").includes(".env is never captured"));
  });
});

test("a package.json seed cannot replace the generated manifest", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const path = join(home, "presets", "withmanifest.json");
    await writeFile(
      path,
      JSON.stringify({
        name: "withmanifest",
        packageManager: "pnpm@10.11.0",
        dependencies: {},
        devDependencies: {},
        files: [{ path: "package.json", contents: "{}" }],
      }),
    );
    const blocked = runCli(
      ["create", "app", "--preset", "withmanifest", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(blocked.code, 1);
    assert.ok(JSON.parse(blocked.stdout).conflicts.join("\n").includes("package.json"));
  });
});

test("creation never touches the source project the preset was packed from", async () => {
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
      ["create", "new-app", "--preset", "sample", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(await readdir(source), listing);
    assert.equal(await readFile(join(source, "src", "index.ts"), "utf8"), "export {};\n");
    assert.equal((await readdir(join(workspace, "new-app")).catch(() => null)) !== null, true);
  });
});

test("a stale preset file fails the reviewed inputs before any mutation", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const presetFile = join(home, "presets", "sample.json");
    const prepared = await planCreate(home, workspace, "new-app", "sample");
    assert.ok(prepared.plan && prepared.extension);
    // Mutating the preset between review and execution must invalidate the plan.
    await writeFile(presetFile, (await readFile(presetFile, "utf8")).replace("sample", "sample2"));
    const stale = await execute(prepared.plan, prepared.extension);
    assert.equal(stale.status, "failed");
    assert.equal(stale.completed.length, 0);
    assert.ok(stale.errors.join(" ").includes("changed"));
    assert.equal(await readdir(join(workspace, "new-app")).catch(() => null), null);
  });
});

test("preset name is not required to match the target directory name", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    const created = runCli(
      ["create", "billing-api", "--preset", "sample", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(created.code, 0, created.stderr);
    const manifest = JSON.parse(
      await readFile(join(workspace, "billing-api", "package.json"), "utf8"),
    );
    assert.equal(manifest.name, "billing-api");
  });
});
