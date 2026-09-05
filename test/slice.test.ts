import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { effectOxlint, versions } from "../src/features/effect-oxlint.ts";
import { execute, read } from "../src/runtime.ts";
import type { Extension, Plan } from "../src/plan.ts";
import { fingerprint } from "../src/plan.ts";

const root = resolve("test/fixtures/project");
function fixture(
  config = '// Keep this comment\n{ "rules": { "eslint/no-debugger": "error" }, "overrides": [{ "files": ["*.js"], "rules": { "eslint/no-var": "error" } }] }',
  prepare = "node setup.mjs",
) {
  const files = new Map<string, string>([
    [
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.11.0",
        dependencies: { effect: versions.effect },
        devDependencies: { oxlint: versions.oxlint },
        scripts: { prepare },
      }),
    ],
    [join(root, ".oxlintrc.jsonc"), config],
    ...["effect", "oxlint"].map((name): [string, string] => [
      join(root, `node_modules/${name}/package.json`),
      JSON.stringify({ version: versions[name] }),
    ]),
  ]);
  return { files, context: { cwd: root, read: async (path: string) => files.get(path) ?? null } };
}

test("dry-run plans additive config, scripts and commands without changing its inputs", async () => {
  const { files, context } = fixture();
  const before = [...files];
  const plan = await effectOxlint.plan(context);
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual([...files], before);
  const config = plan.operations.find((op) => op.kind === "write" && op.path.endsWith(".jsonc"));
  assert.ok(config?.kind === "write");
  assert.ok(config.after.startsWith("// Keep this comment"));
  assert.equal(parse(config.after).rules["eslint/no-debugger"], "error");
  assert.equal(parse(config.after).overrides[0].rules["eslint/no-var"], "error");
  const manifest = plan.operations.find(
    (op) => op.kind === "write" && op.path.endsWith("package.json"),
  );
  assert.ok(manifest?.kind === "write");
  assert.equal(
    JSON.parse(manifest.after).scripts.prepare,
    "node setup.mjs && effect-tsgo patch --no-typescript --oxlint",
  );
  assert.equal(plan.operations.filter((op) => op.kind === "command").length, 2);
});

test("conflicting explicit rules, overrides and unsupported scripts block plans", async () => {
  for (const config of [
    '{"rules":{"effecttsgo/strict-effect-provide":"off"}}',
    '{"rules":{"effecttsgo/floating-effect":"off"}}',
    '{"overrides":[{"files":["src/**"],"rules":{"effecttsgo/strict-effect-provide":"off"}}]}',
    '{"options":{"typeAware":false}}',
    '{"extends":["external-preset"]}',
  ]) {
    assert.ok((await effectOxlint.plan(fixture(config).context)).conflicts.length);
  }
  assert.ok(
    (await effectOxlint.plan(fixture("{}", "node setup.mjs || exit 0").context)).conflicts.length,
  );
});

test("existing custom plugin contents are never overwritten", async () => {
  const { files, context } = fixture();
  files.set(join(root, ".config/oxlint/tamo-effect.ts"), "// User's plugin");
  const plan = await effectOxlint.plan(context);
  assert.ok(plan.conflicts.some((v) => v.includes("differs")));
  const blocked = await execute(plan, effectOxlint);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.completed.length, 0);
});

test("incompatible prerequisites and ambiguous config block", async () => {
  const { files, context } = fixture();
  files.set(join(root, "node_modules/effect/package.json"), '{"version":"3.0.0"}');
  files.set(join(root, ".oxlintrc.json"), "{}");
  const plan = await effectOxlint.plan(context);
  assert.ok(plan.conflicts.some((v) => v.includes("3.0.0")));
  assert.ok(plan.conflicts.some((v) => v.includes("exactly one")));
});

test("a nested workspace target blocks before an install can escape the project", async () => {
  const { files, context } = fixture();
  files.set(join(dirname(root), "pnpm-workspace.yaml"), "packages: ['project']");
  const plan = await effectOxlint.plan(context);
  assert.ok(plan.conflicts.some((v) => v.includes("parent pnpm workspace")));
  assert.equal((await execute(plan, effectOxlint)).status, "blocked");
});

test("inherited settings cannot silently be replaced by the integration", async () => {
  const { files, context } = fixture('{"extends":["./base.json"]}');
  files.set(join(root, "base.json"), '{"plugins":["react"]}');
  assert.ok(
    (await effectOxlint.plan(context)).conflicts.some((v) =>
      v.includes("Inherited plugin/options"),
    ),
  );
});

test("executor rejects stale inputs and reports applied files on validation failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-test-"));
  try {
    const path = join(cwd, "config.json");
    await writeFile(path, "before");
    const plan: Plan = {
      cwd,
      extension: "test",
      evidence: [],
      conflicts: [],
      validation: [],
      inputs: [{ path, hash: fingerprint("before") }],
      operations: [{ kind: "write", path, before: "before", after: "after" }],
    };
    const extension: Extension = {
      id: "test",
      description: "test",
      plan: async () => plan,
      validate: async () => ["probe failed"],
    };
    await writeFile(path, "user edit");
    const stale = await execute(plan, extension);
    assert.equal(stale.status, "failed");
    assert.equal(stale.completed.length, 0);
    assert.equal(await read(path), "user edit");
    await writeFile(path, "before");
    const failed = await execute(plan, extension);
    assert.equal(failed.status, "failed");
    assert.equal(failed.completed.length, 1);
    assert.equal(await readFile(path, "utf8"), "after");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a failed command stops execution and reports earlier writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-command-test-"));
  try {
    const path = join(cwd, "created.txt");
    const plan: Plan = {
      cwd,
      extension: "test",
      evidence: [],
      conflicts: [],
      validation: [],
      inputs: [{ path, hash: null }],
      operations: [
        { kind: "write", path, before: null, after: "created" },
        {
          kind: "command",
          executable: process.execPath,
          args: ["-e", "process.exit(3)"],
          cwd,
          purpose: "Fail deliberately",
        },
        { kind: "write", path: join(cwd, "never.txt"), before: null, after: "never" },
      ],
    };
    const extension: Extension = {
      id: "test",
      description: "test",
      plan: async () => plan,
      validate: async () => {
        assert.fail("must not validate after command failure");
      },
    };
    const result = await execute(plan, extension);
    assert.equal(result.status, "failed");
    assert.equal(result.completed.length, 1);
    assert.equal(result.remaining.length, 2);
    assert.equal(await read(join(cwd, "never.txt")), null);
    assert.equal(await read(path), "created");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
