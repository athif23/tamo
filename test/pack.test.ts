import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tamoHome } from "../src/home.ts";
import { inspectProject } from "../src/inspect.ts";
import { checkSeedContents, collectIncludedFiles, packRecipe } from "../src/pack.ts";
import { loadRecipe, saveRecipe } from "../src/recipes.ts";

const root = resolve(".");
const manifest = JSON.stringify({
  name: "source-project",
  version: "1.0.0",
  private: true,
  type: "module",
  packageManager: "pnpm@10.11.0",
  scripts: { build: "tsc" },
  dependencies: { effect: "4.0.0-rc.112", stripe: "^18.0.0" },
  devDependencies: { oxlint: "1.80.0", vitest: "^3.0.0" },
});

async function withProject(
  run: (cwd: string) => Promise<void>,
  files: Record<string, string> = { "package.json": manifest },
) {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-pack-"));
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

function runCli(args: string[], home: string) {
  const result = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, TAMO_HOME: home },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("TAMO_HOME relocates the Tamo home", () => {
  const original = process.env.TAMO_HOME;
  try {
    process.env.TAMO_HOME = join(tmpdir(), "tamo-home-override");
    assert.equal(tamoHome(), join(tmpdir(), "tamo-home-override"));
    delete process.env.TAMO_HOME;
    assert.ok(tamoHome().endsWith(".tamo"));
  } finally {
    if (original === undefined) delete process.env.TAMO_HOME;
    else process.env.TAMO_HOME = original;
  }
});

test("inspection reports factual state without reusable-set judgment", async () => {
  await withProject(
    async (cwd) => {
      const inspection = await inspectProject(cwd);
      assert.equal(inspection.kind, "node");
      assert.equal(inspection.packageManager, "pnpm@10.11.0");
      assert.deepEqual(inspection.dependencies, { effect: "4.0.0-rc.112", stripe: "^18.0.0" });
      assert.deepEqual(inspection.devDependencies, { oxlint: "1.80.0", vitest: "^3.0.0" });
      assert.deepEqual(inspection.configFiles, [".oxlintrc.jsonc", "tsconfig.json"]);
      assert.deepEqual(inspection.notes, []);
    },
    {
      "package.json": manifest,
      "tsconfig.json": "{}",
      ".oxlintrc.jsonc": "{}",
    },
  );
});

test("inspection reports unknown state for an empty directory", async () => {
  await withProject(async (cwd) => {
    const inspection = await inspectProject(cwd);
    assert.equal(inspection.kind, "unknown");
    assert.ok(inspection.notes.some((note) => note.includes("No package.json")));
  }, {});
});

test("inspection notes a workspace manifest instead of failing", async () => {
  await withProject(
    async (cwd) => {
      const inspection = await inspectProject(cwd);
      assert.ok(inspection.notes.some((note) => note.includes("workspace")));
    },
    { "package.json": manifest, "pnpm-workspace.yaml": "packages:\n  - .\n" },
  );
});

test("pack captures the manifest as a native artifact minus name and version", async () => {
  await withProject(async (cwd) => {
    const before = await readFile(join(cwd, "package.json"));
    const packed = await packRecipe(cwd, "web", [], []);
    assert.deepEqual(packed.conflicts, []);
    assert.deepEqual(
      packed.recipe!.artifacts.map((artifact) => artifact.path),
      ["package.json"],
    );
    const captured = JSON.parse(packed.recipe!.artifacts[0]!.contents);
    assert.equal(captured.name, undefined);
    assert.equal(captured.version, undefined);
    // Everything else rides along verbatim: no field allowlist.
    assert.equal(captured.private, true);
    assert.equal(captured.type, "module");
    assert.equal(captured.packageManager, "pnpm@10.11.0");
    assert.deepEqual(captured.scripts, { build: "tsc" });
    assert.deepEqual(captured.dependencies, { effect: "4.0.0-rc.112", stripe: "^18.0.0" });
    // The source project is byte-for-byte untouched by the capture.
    assert.deepEqual(await readFile(join(cwd, "package.json")), before);
  });
});

test("UTF-8 with BOM packs as text while invalid bytes still block", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-bom-"));
  try {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(join(cwd, "package.json"), Buffer.concat([bom, Buffer.from(manifest)]));
    await writeFile(
      join(cwd, "tsconfig.json"),
      Buffer.concat([bom, Buffer.from('{"compilerOptions":{"strict":true}}\n')]),
    );
    await writeFile(join(cwd, "notes.txt"), Buffer.concat([bom, Buffer.from("hello\n")]));
    const before = await readFile(join(cwd, "package.json"));

    // A BOM manifest still inspects factually.
    const inspection = await inspectProject(cwd);
    assert.equal(inspection.kind, "node");
    assert.equal(inspection.packageManager, "pnpm@10.11.0");

    const packed = await packRecipe(cwd, "web", ["tsconfig.json", "notes.txt"], []);
    assert.deepEqual(packed.conflicts, [], packed.conflicts.join("\n"));
    assert.deepEqual(packed.recipe!.artifacts.map((artifact) => artifact.path).sort(), [
      "notes.txt",
      "package.json",
      "tsconfig.json",
    ]);
    const captured = JSON.parse(
      packed.recipe!.artifacts.find((artifact) => artifact.path === "package.json")!.contents,
    );
    assert.equal(captured.name, undefined);
    assert.equal(captured.version, undefined);
    assert.deepEqual(captured.dependencies, { effect: "4.0.0-rc.112", stripe: "^18.0.0" });
    // The BOM normalizes away: packed artifacts stay valid text.
    for (const artifact of packed.recipe!.artifacts)
      assert.notEqual(artifact.contents.charCodeAt(0), 0xfeff, artifact.path);

    // The source project is byte-for-byte untouched, BOM included.
    assert.deepEqual(await readFile(join(cwd, "package.json")), before);

    // Genuinely invalid bytes are still rejected as binary.
    await writeFile(join(cwd, "binary.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
    const blocked = await collectIncludedFiles(cwd, ["binary.dat"]);
    assert.deepEqual(blocked.files, []);
    assert.ok(
      blocked.conflicts.some((conflict) => conflict.includes("binary")),
      blocked.conflicts.join("\n"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("excludes omit through the shared machinery and unknown excludes are flagged", async () => {
  await withProject(async (cwd) => {
    const packed = await packRecipe(cwd, "web", [], ["stripe", "vitest", "nope"]);
    assert.ok(packed.conflicts.some((conflict) => conflict.includes("nope")));
    assert.equal(packed.recipe, undefined);
  });
  await withProject(async (cwd) => {
    const packed = await packRecipe(cwd, "web", [], ["stripe", "vitest"]);
    assert.deepEqual(packed.conflicts, []);
    const captured = JSON.parse(packed.recipe!.artifacts[0]!.contents);
    assert.deepEqual(captured.dependencies, { effect: "4.0.0-rc.112" });
    assert.deepEqual(captured.devDependencies, { oxlint: "1.80.0" });
    // Selection edits never touch the source project.
    assert.ok(JSON.parse(await readFile(join(cwd, "package.json"), "utf8")).dependencies.stripe);
  });
});

test("explicitly included files enter the recipe with their contents", async () => {
  await withProject(
    async (cwd) => {
      const included = await collectIncludedFiles(cwd, ["tsconfig.json", "src/lib/result.ts"]);
      assert.deepEqual(included.conflicts, []);
      assert.deepEqual(included.files, [
        { path: "tsconfig.json", contents: "{}" },
        { path: "src/lib/result.ts", contents: "export {};\n" },
      ]);
    },
    { "package.json": manifest, "tsconfig.json": "{}", "src/lib/result.ts": "export {};\n" },
  );
});

test(".env.example is capturable reusable content while .env stays denied", async () => {
  await withProject(
    async (cwd) => {
      const included = await collectIncludedFiles(cwd, [".env.example", ".env"]);
      assert.deepEqual(included.files, [{ path: ".env.example", contents: "SECRET_KEY=\n" }]);
      assert.ok(included.conflicts.join("\n").includes(".env "));
    },
    { "package.json": manifest, ".env": "SECRET_KEY=real", ".env.example": "SECRET_KEY=\n" },
  );
});

test("secrets, generated state, and boundary escapes are never captured", async () => {
  await withProject(
    async (cwd) => {
      await mkdir(join(cwd, "node_modules"), { recursive: true });
      const included = await collectIncludedFiles(cwd, [
        ".env",
        ".config/credentials.key",
        "src/.env.local",
        "node_modules",
        "missing.ts",
        "../outside.txt",
      ]);
      assert.deepEqual(included.files, []);
      const joined = included.conflicts.join("\n");
      for (const expected of [
        ".env",
        "credentials.key",
        ".env.local",
        "node_modules",
        "does not exist",
        "inside the project",
      ])
        assert.ok(joined.includes(expected), `expected conflict mentioning ${expected}`);
    },
    {
      "package.json": manifest,
      ".env": "SECRET=1",
      "src/.env.local": "SECRET=2",
      ".config/credentials.key": "k",
    },
  );
});

test("stored recipe paths get the same policy without filesystem access", () => {
  assert.deepEqual(checkSeedContents([{ path: "tsconfig.json", contents: "{}" }]), []);
  assert.ok(
    checkSeedContents([{ path: ".env", contents: "x" }])
      .join("\n")
      .includes(".env is never captured"),
  );
});

test("recipes round-trip through an isolated home byte-for-byte", async () => {
  const home = await mkdtemp(join(tmpdir(), "tamo-home-"));
  try {
    const artifacts = [
      { path: "package.json", contents: '{"private":true}\n' },
      { path: "tsconfig.json", contents: "{}" },
    ];
    const path = await saveRecipe(home, "web", artifacts);
    assert.equal(path, join(home, "recipes", "web"));
    const loaded = await loadRecipe(home, "web");
    assert.deepEqual(loaded.conflicts, []);
    assert.equal(loaded.recipe!.name, "web");
    assert.deepEqual(loaded.recipe!.artifacts, artifacts);
    assert.equal(loaded.snapshots.length, 3);
    assert.equal((await loadRecipe(home, "other")).recipe, undefined);
    assert.ok(
      (await loadRecipe(home, "other")).conflicts.some((conflict: string) =>
        conflict.includes("Unknown recipe: other"),
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the pack slice: dry-run saves nothing, noninteractive needs --yes, repack is explicit, source is untouched", async () => {
  await withProject(
    async (cwd) => {
      const home = await mkdtemp(join(tmpdir(), "tamo-home-"));
      try {
        await writeFile(join(cwd, "tsconfig.json"), "{}");

        const snapshot = await readFile(join(cwd, "package.json"), "utf8");
        const listing = await readdir(cwd);

        const dry = runCli(["pack", "web", "--cwd", cwd, "--json", "--dry-run"], home);
        assert.equal(dry.code, 0, dry.stderr);
        const dryRun = JSON.parse(dry.stdout);
        assert.equal(dryRun.status, "dry-run");
        assert.equal(dryRun.recipe.name, "web");
        assert.deepEqual(
          dryRun.recipe.artifacts.map((artifact: { path: string }) => artifact.path),
          ["package.json"],
        );
        assert.equal(await readdir(join(home, "recipes")).catch(() => null), null);

        const unconfirmed = runCli(["pack", "web", "--cwd", cwd, "--json"], home);
        assert.equal(unconfirmed.code, 2);
        assert.equal(JSON.parse(unconfirmed.stdout).status, "confirmation-required");

        const saved = runCli(
          ["pack", "web", "--cwd", cwd, "--json", "--yes", "--include", "tsconfig.json"],
          home,
        );
        assert.equal(saved.code, 0, saved.stderr);
        const savedResult = JSON.parse(saved.stdout);
        assert.equal(savedResult.status, "saved");
        assert.deepEqual(
          savedResult.recipe.artifacts.map((artifact: { path: string }) => artifact.path),
          ["package.json", "tsconfig.json"],
        );
        assert.equal(await readFile(join(home, "recipes", "web", "recipe.json"), "utf8"), "{}\n");
        assert.deepEqual(
          JSON.parse(
            await readFile(join(home, "recipes", "web", "artifacts", "package.json"), "utf8"),
          ).dependencies,
          { effect: "4.0.0-rc.112", stripe: "^18.0.0" },
        );

        const repack = runCli(["pack", "web", "--cwd", cwd, "--json", "--yes"], home);
        assert.equal(repack.code, 1);
        assert.equal(JSON.parse(repack.stdout).status, "blocked");
        assert.ok(JSON.parse(repack.stdout).conflicts[0].includes("already exists"));

        const forced = runCli(
          ["pack", "web", "--cwd", cwd, "--json", "--yes", "--force", "--exclude", "stripe"],
          home,
        );
        assert.equal(forced.code, 0, forced.stderr);
        const forcedResult = JSON.parse(forced.stdout);
        assert.deepEqual(JSON.parse(forcedResult.recipe.artifacts[0].contents).dependencies, {
          effect: "4.0.0-rc.112",
        });
        // Repack rebuilds from the current project: previously included files
        // are not silently merged in, and deselected artifacts do not linger.
        assert.deepEqual(
          forcedResult.recipe.artifacts.map((artifact: { path: string }) => artifact.path),
          ["package.json"],
        );
        assert.deepEqual(await readdir(join(home, "recipes", "web", "artifacts")), [
          "package.json",
        ]);

        assert.equal(await readFile(join(cwd, "package.json"), "utf8"), snapshot);
        assert.deepEqual(await readdir(cwd), listing);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    {
      "package.json": manifest,
      "tsconfig.json": "{}",
      ".env": "SECRET=1",
    },
  );
});

test("an unsupported project reports blocked conflicts, not a candidate failure", async () => {
  await withProject(async (cwd) => {
    const home = await mkdtemp(join(tmpdir(), "tamo-home-"));
    try {
      const blocked = runCli(["pack", "rust", "--cwd", cwd, "--json", "--yes"], home);
      assert.equal(blocked.code, 1);
      const result = JSON.parse(blocked.stdout);
      assert.equal(result.status, "blocked");
      assert.ok(
        result.conflicts.some((conflict: string) => conflict.includes("Only Node projects")),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, {});
});
