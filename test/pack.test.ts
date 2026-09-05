import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tamoHome } from "../src/home.ts";
import { inspectProject } from "../src/inspect.ts";
import { buildCandidate, collectIncludedFiles } from "../src/pack.ts";
import { loadPreset, presetPath, savePreset, validatePreset } from "../src/preset.ts";

const root = resolve(".");
const manifest = JSON.stringify({
  packageManager: "pnpm@10.11.0",
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

test("the candidate suggests manifest dependencies and captures no files automatically", async () => {
  await withProject(async (cwd) => {
    const candidate = buildCandidate(await inspectProject(cwd), []);
    assert.deepEqual(candidate.conflicts, []);
    assert.deepEqual(candidate.preset.dependencies, { effect: "4.0.0-rc.112", stripe: "^18.0.0" });
    assert.deepEqual(candidate.preset.devDependencies, { oxlint: "1.80.0", vitest: "^3.0.0" });
    assert.deepEqual(candidate.preset.files, []);
  });
});

test("excludes drop dependencies and unknown excludes are flagged", async () => {
  await withProject(async (cwd) => {
    const candidate = buildCandidate(await inspectProject(cwd), ["stripe", "nope"]);
    assert.deepEqual(candidate.preset.dependencies, { effect: "4.0.0-rc.112" });
    assert.ok(candidate.conflicts.some((conflict) => conflict.includes("nope")));
  });
});

test("explicitly included files enter the candidate with their contents", async () => {
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

test(".env.example is capturable reusable seed content while .env stays denied", async () => {
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

test("preset validation rejects unknown keys, bad names, and escaping paths", () => {
  const base = { name: "web", packageManager: "pnpm@10" };
  assert.throws(() => validatePreset({ ...base, surprise: 1 }, "test"), /Unknown preset key/);
  assert.throws(() => validatePreset({ ...base, name: "../web" }, "test"), /name must match/);
  assert.throws(
    () => validatePreset({ ...base, files: [{ path: "../escape.txt", contents: "" }] }, "test"),
    /stay inside the project/,
  );
  assert.throws(
    () => validatePreset({ ...base, dependencies: { effect: 4 } }, "test"),
    /version strings/,
  );
});

test("presets round-trip through an isolated home", async () => {
  const home = await mkdtemp(join(tmpdir(), "tamo-home-"));
  try {
    const preset = validatePreset(
      { ...JSON.parse(manifest), name: "web", files: [{ path: "tsconfig.json", contents: "{}" }] },
      "test",
    );
    const path = await savePreset(home, preset);
    assert.equal(path, presetPath(home, "web"));
    assert.deepEqual(await loadPreset(home, "web"), preset);
    assert.equal(await loadPreset(home, "other"), null);
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
        assert.deepEqual(dryRun.preset.dependencies, { effect: "4.0.0-rc.112", stripe: "^18.0.0" });
        assert.deepEqual(dryRun.preset.files, []);
        assert.equal(await readdir(join(home, "presets")).catch(() => null), null);

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
        assert.deepEqual(savedResult.preset.files, [{ path: "tsconfig.json", contents: "{}" }]);
        assert.deepEqual(JSON.parse(await readFile(savedResult.path, "utf8")), savedResult.preset);

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
        assert.deepEqual(forcedResult.preset.dependencies, { effect: "4.0.0-rc.112" });
        // Repack rebuilds from the current project, so previously included files
        // are not silently merged in; they must be selected again.
        assert.deepEqual(forcedResult.preset.files, []);

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

test("a reviewed agent candidate saves through --from", async () => {
  await withProject(
    async (cwd) => {
      const home = await mkdtemp(join(tmpdir(), "tamo-home-"));
      try {
        const candidate = join(home, "candidate.json");
        await writeFile(
          candidate,
          JSON.stringify({
            name: "web",
            packageManager: "pnpm@10.11.0",
            dependencies: { effect: "4.0.0-rc.112" },
            devDependencies: {},
            files: [{ path: "tsconfig.json", contents: "{}" }],
          }),
        );
        const saved = runCli(
          ["pack", "web", "--cwd", cwd, "--json", "--yes", "--from", candidate],
          home,
        );
        assert.equal(saved.code, 0, saved.stderr);
        const savedResult = JSON.parse(saved.stdout);
        assert.equal(savedResult.status, "saved");
        assert.deepEqual(savedResult.preset.dependencies, { effect: "4.0.0-rc.112" });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    { "package.json": manifest, "tsconfig.json": "{}" },
  );
});
