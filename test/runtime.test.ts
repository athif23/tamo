import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan, read } from "../src/runtime.ts";
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
