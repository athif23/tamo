import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { executePlan, read, resolveWindowsPnpm } from "../src/runtime.ts";
import type { Plan } from "../src/plan.ts";
import { fingerprint } from "../src/plan.ts";

test("executor rejects stale inputs before any mutation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-test-"));
  try {
    const path = join(cwd, "config.json");
    await writeFile(path, "before");
    const plan: Plan = {
      cwd,
      subject: "test",
      evidence: [],
      conflicts: [],
      validation: [],
      requiresReplan: false,
      inputs: [{ path, hash: fingerprint("before") }],
      operations: [{ kind: "write", path, before: "before", after: "after" }],
    };
    await writeFile(path, "user edit");
    const stale = await executePlan(plan);
    assert.equal(stale.status, "failed");
    assert.equal(stale.completed.length, 0);
    assert.equal(await read(path), "user edit");
    await writeFile(path, "before");
    const applied = await executePlan(plan);
    assert.equal(applied.status, "applied");
    assert.equal(applied.completed.length, 1);
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
      subject: "test",
      evidence: [],
      conflicts: [],
      validation: [],
      requiresReplan: false,
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
    const result = await executePlan(plan);
    assert.equal(result.status, "failed");
    assert.equal(result.completed.length, 1);
    assert.equal(result.remaining.length, 2);
    assert.equal(await read(join(cwd, "never.txt")), null);
    assert.equal(await read(path), "created");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Windows pnpm resolution without platform fragility: the lookup core is
// pure, so POSIX-style fake layouts exercise the same `;`-separated PATH
// scan and sibling-entry probing on any host. No test touches the real
// process.platform, PATH, or filesystem.
function fakeExists(files: Set<string>): (path: string) => boolean {
  return (path) => files.has(path);
}

test("windows pnpm prefers the pnpm-managed entry for both cjs and mjs", () => {
  for (const file of ["pnpm.cjs", "pnpm.mjs"]) {
    const entry = join("/opt", "pnpm", "bin", file);
    const resolved = resolveWindowsPnpm(["install"], {
      npmExecpath: entry,
      pathEnv: "",
      nodeExecutable: "/node",
      fileExists: fakeExists(new Set([entry])),
    });
    assert.deepEqual(resolved, { executable: "/node", args: [entry, "install"] });
  }
});

test("windows pnpm ignores non-pnpm entries and missing files", () => {
  const npmEntry = join("/opt", "npm", "bin", "npm-cli.js");
  const resolved = resolveWindowsPnpm(["install"], {
    npmExecpath: npmEntry,
    pathEnv: "",
    nodeExecutable: "/node",
    fileExists: fakeExists(new Set([npmEntry])),
  });
  assert.equal(resolved, null);

  const missing = join("/opt", "pnpm", "bin", "pnpm.mjs");
  const fallback = resolveWindowsPnpm(["install"], {
    npmExecpath: missing,
    pathEnv: "",
    nodeExecutable: "/node",
    fileExists: fakeExists(new Set()),
  });
  assert.equal(fallback, null);
});

test("windows pnpm runs a standalone pnpm.exe directly without a shell", () => {
  const dir = join("/opt", "pnpm");
  const exe = join(dir, "pnpm.exe");
  const resolved = resolveWindowsPnpm(["install", "--frozen-lockfile"], {
    npmExecpath: undefined,
    pathEnv: ["/usr/bin", dir].join(";"),
    nodeExecutable: "/node",
    fileExists: fakeExists(new Set([exe])),
  });
  assert.deepEqual(resolved, {
    executable: exe,
    args: ["install", "--frozen-lockfile"],
  });
});

test("windows pnpm resolves a shim to its self-managed sibling entry", () => {
  const dir = join("/opt", "pnpm", "11.7.0", "bin");
  const shim = join(dir, "pnpm.cmd");
  const entry = join(dirname(shim), "..", "node_modules", "pnpm", "bin", "pnpm.mjs");
  const resolved = resolveWindowsPnpm(["install"], {
    npmExecpath: undefined,
    pathEnv: ["/usr/bin", dir].join(";"),
    nodeExecutable: "/node",
    fileExists: fakeExists(new Set([shim, entry])),
  });
  assert.deepEqual(resolved, { executable: "/node", args: [entry, "install"] });
});

test("windows pnpm resolves a shim to its npm-global sibling entry", () => {
  const dir = join("/opt", "npm");
  const shim = join(dir, "pnpm.cmd");
  const entry = join(dirname(shim), "node_modules", "pnpm", "bin", "pnpm.cjs");
  const resolved = resolveWindowsPnpm(["install"], {
    npmExecpath: undefined,
    pathEnv: dir,
    nodeExecutable: "/node",
    fileExists: fakeExists(new Set([shim, entry])),
  });
  assert.deepEqual(resolved, { executable: "/node", args: [entry, "install"] });
});

test("windows pnpm returns null when no shim or entry exists", () => {
  const resolved = resolveWindowsPnpm(["install"], {
    npmExecpath: undefined,
    pathEnv: ["/usr/bin", "/opt/empty"].join(";"),
    nodeExecutable: "/node",
    fileExists: fakeExists(new Set()),
  });
  assert.equal(resolved, null);
});
