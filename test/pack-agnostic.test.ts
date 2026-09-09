import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectIncludedFiles, packRecipe } from "../src/pack.ts";

function baseManifest(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "source-project",
    version: "1.0.0",
    private: true,
    dependencies: { "ok-lib": "1.0.0" },
    ...extra,
  });
}

async function withProject(
  files: Record<string, string>,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-pack-agnostic-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), contents);
    }
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("pack succeeds with no packageManager and no lockfile", async () => {
  await withProject({ "package.json": baseManifest() }, async (cwd) => {
    const before = await readFile(join(cwd, "package.json"));
    const packed = await packRecipe(cwd, "web", [], []);
    assert.deepEqual(packed.conflicts, [], packed.conflicts.join("\n"));
    const captured = JSON.parse(packed.recipe!.artifacts[0]!.contents);
    assert.equal(captured.name, undefined);
    assert.equal(captured.version, undefined);
    assert.equal("packageManager" in captured, false);
    assert.deepEqual(await readFile(join(cwd, "package.json")), before);
  });
});

test("pack succeeds with pnpm, npm, and bun lockfiles present", async () => {
  for (const lockfile of ["pnpm-lock.yaml", "package-lock.json", "bun.lock", "yarn.lock"]) {
    await withProject(
      { "package.json": baseManifest(), [lockfile]: "lockfile-stub\n" },
      async (cwd) => {
        const before = await readFile(join(cwd, "package.json"), "utf8");
        const packed = await packRecipe(cwd, "web", [], []);
        assert.deepEqual(packed.conflicts, [], `${lockfile}: ${packed.conflicts.join("\n")}`);
        const paths = packed.recipe!.artifacts.map((artifact) => artifact.path);
        assert.deepEqual(paths, ["package.json"]);
        assert.equal(await readFile(join(cwd, "package.json"), "utf8"), before);
      },
    );
  }
});

test("pack succeeds with binary bun.lockb present", async () => {
  await withProject(
    { "package.json": baseManifest(), "bun.lockb": "bun-binary-stub\n" },
    async (cwd) => {
      const packed = await packRecipe(cwd, "web", [], []);
      assert.deepEqual(packed.conflicts, [], packed.conflicts.join("\n"));
      assert.deepEqual(
        packed.recipe!.artifacts.map((artifact) => artifact.path),
        ["package.json"],
      );
    },
  );
});

test("pack succeeds with multiple lockfiles without choosing one", async () => {
  await withProject(
    {
      "package.json": baseManifest(),
      "pnpm-lock.yaml": "pnpm\n",
      "package-lock.json": "{}\n",
      "yarn.lock": "yarn\n",
      "bun.lock": "bun\n",
    },
    async (cwd) => {
      const packed = await packRecipe(cwd, "web", [], []);
      assert.deepEqual(packed.conflicts, [], packed.conflicts.join("\n"));
      assert.deepEqual(
        packed.recipe!.artifacts.map((artifact) => artifact.path),
        ["package.json"],
      );
    },
  );
});

test("pack preserves explicit packageManager values without inventing one", async () => {
  for (const packageManager of ["pnpm@10.11.0", "npm@10.8.0", "yarn@4.0.0", "bun@1.2.0"]) {
    await withProject({ "package.json": baseManifest({ packageManager }) }, async (cwd) => {
      const before = await readFile(join(cwd, "package.json"));
      const packed = await packRecipe(cwd, "web", [], []);
      assert.deepEqual(packed.conflicts, [], `${packageManager}: ${packed.conflicts.join("\n")}`);
      const captured = JSON.parse(packed.recipe!.artifacts[0]!.contents);
      assert.equal(captured.packageManager, packageManager);
      assert.deepEqual(await readFile(join(cwd, "package.json")), before);
    });
  }
});

test("packed manifest strips name/version and never invents packageManager", async () => {
  await withProject({ "package.json": baseManifest() }, async (cwd) => {
    const packed = await packRecipe(cwd, "web", [], []);
    const captured = JSON.parse(packed.recipe!.artifacts[0]!.contents);
    assert.equal(captured.name, undefined);
    assert.equal(captured.version, undefined);
    assert.equal("packageManager" in captured, false);
    assert.deepEqual(captured.dependencies, { "ok-lib": "1.0.0" });
  });
});

test("lockfiles remain excluded even when explicitly included", async () => {
  await withProject(
    {
      "package.json": baseManifest(),
      "pnpm-lock.yaml": "pnpm\n",
      "package-lock.json": "{}\n",
      "bun.lock": "bun\n",
      "bun.lockb": "bunb\n",
      "yarn.lock": "yarn\n",
    },
    async (cwd) => {
      for (const lockfile of [
        "pnpm-lock.yaml",
        "package-lock.json",
        "bun.lock",
        "bun.lockb",
        "yarn.lock",
      ]) {
        const included = await collectIncludedFiles(cwd, [lockfile]);
        assert.deepEqual(included.files, [], lockfile);
        assert.ok(
          included.conflicts.some((conflict) => conflict.includes(lockfile)),
          `${lockfile}: ${included.conflicts.join("\n")}`,
        );
      }
    },
  );
});
