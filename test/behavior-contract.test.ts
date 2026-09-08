import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planComposition,
  verifyComposition,
  type BehaviorFragment,
  type CompositionInput,
  type Recipe,
  type RecipeBehavior,
} from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { read } from "../src/runtime.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];
const satisfiedManifest = JSON.stringify({ dependencies: { "v-lib": "1.0.0" } });

// Malformed durable JavaScript bypasses TypeScript, so fixtures smuggle
// malformed values through unknown the way an imported behavior.mjs
// default export arrives; Core revalidates every value at runtime.
const fragment = (value: unknown): BehaviorFragment =>
  // SAFETY: deliberate malformed-fixture smuggling past the static boundary.
  value as BehaviorFragment;
const failures = (value: unknown): string[] =>
  // SAFETY: deliberate malformed-fixture smuggling past the static boundary.
  value as string[];

async function withTarget(run: (target: string) => Promise<void>): Promise<void> {
  const target = await mkdtemp(join(tmpdir(), "tamo-behavior-contract-"));
  try {
    await writeFile(join(target, "package.json"), satisfiedManifest);
    await run(target);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

function inputFor(
  target: string,
  recipes: Record<string, Recipe>,
  entry: string,
): CompositionInput {
  return { cwd: target, recipes, entry, invocation: [], handlers, read };
}

function recipeWithPrepare(hook: NonNullable<RecipeBehavior["prepare"]>): Recipe {
  return {
    name: "web",
    artifacts: [{ path: "package.json", contents: satisfiedManifest }],
    behavior: { prepare: hook },
  };
}

function recipeWithFinalize(hook: NonNullable<RecipeBehavior["finalize"]>): Recipe {
  return {
    name: "web",
    artifacts: [{ path: "package.json", contents: satisfiedManifest }],
    behavior: { finalize: hook },
  };
}

test("prepare undefined plans as an empty fragment", async () => {
  await withTarget(async (target) => {
    const recipes = { web: recipeWithPrepare(async () => fragment(undefined)) };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.deepEqual(prepared.conflicts, []);
    assert.deepEqual(prepared.plan!.operations, []);
  });
});

test("prepare {} plans as an empty fragment", async () => {
  await withTarget(async (target) => {
    const recipes = { web: recipeWithPrepare(async () => fragment({})) };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.deepEqual(prepared.conflicts, []);
    assert.deepEqual(prepared.plan!.operations, []);
  });
});

test("prepare with omitted fields and a valid command plans the preparation stage", async () => {
  await withTarget(async (target) => {
    const recipes = {
      web: recipeWithPrepare(async (context) => {
        const cwd = context.cwd;
        return fragment({
          evidence: ["initializer needed"],
          operations: [
            {
              kind: "command",
              executable: process.execPath,
              args: ["-e", "process.exit(0)"],
              cwd,
              purpose: "Generate fixture state",
            },
          ],
        });
      }),
    };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.deepEqual(prepared.conflicts, []);
    assert.equal(prepared.plan!.requiresReplan, true);
    assert.deepEqual(
      prepared.plan!.operations.map((operation) => operation.kind),
      ["command"],
    );
    assert.ok(prepared.plan!.evidence.includes("initializer needed"));
  });
});

test("prepare rejects an unknown result key with the hook named", async () => {
  await withTarget(async (target) => {
    const recipes = { web: recipeWithPrepare(async () => fragment({ bogus: 1 })) };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.equal(prepared.plan, undefined);
    assert.equal(prepared.conflicts.length, 1);
    assert.ok(prepared.conflicts[0]!.includes("prepare"), prepared.conflicts[0]);
    assert.ok(prepared.conflicts[0]!.includes("unknown key(s): bogus"), prepared.conflicts[0]);
    assert.ok(!/Cannot read properties|not iterable/.test(prepared.conflicts[0]!));
  });
});

test("prepare rejects conflicts that are not a string array", async () => {
  await withTarget(async (target) => {
    for (const value of ["oops", [42], [null]]) {
      const recipes = { web: recipeWithPrepare(async () => fragment({ conflicts: value })) };
      const prepared = await planComposition(inputFor(target, recipes, "web"));
      assert.equal(prepared.plan, undefined, JSON.stringify(value));
      assert.ok(
        prepared.conflicts.some((conflict) => conflict.includes("prepare")),
        prepared.conflicts.join("\n"),
      );
      assert.ok(
        prepared.conflicts.some((conflict) => conflict.includes("conflicts")),
        prepared.conflicts.join("\n"),
      );
    }
  });
});

test("prepare rejects evidence that is not a string array", async () => {
  await withTarget(async (target) => {
    const recipes = { web: recipeWithPrepare(async () => fragment({ evidence: [null] })) };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.equal(prepared.plan, undefined);
    assert.ok(
      prepared.conflicts.some(
        (conflict) => conflict.includes("prepare") && conflict.includes("evidence"),
      ),
      prepared.conflicts.join("\n"),
    );
  });
});

test("prepare rejects malformed command operations with the field named", async () => {
  await withTarget(async (target) => {
    const recipes = {
      web: recipeWithPrepare(async () =>
        fragment({
          operations: [{ kind: "command", args: [], cwd: target, purpose: "missing executable" }],
        }),
      ),
    };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.equal(prepared.plan, undefined);
    assert.ok(
      prepared.conflicts.some(
        (conflict) =>
          conflict.includes("prepare") &&
          conflict.includes("operations[0]") &&
          conflict.includes("executable"),
      ),
      prepared.conflicts.join("\n"),
    );
  });
});

test("prepare rejects write operations explicitly", async () => {
  await withTarget(async (target) => {
    const recipes = {
      web: recipeWithPrepare(async () =>
        fragment({
          operations: [{ kind: "write", path: join(target, "x"), before: null, after: "y" }],
        }),
      ),
    };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.equal(prepared.plan, undefined);
    assert.ok(
      prepared.conflicts.some(
        (conflict) =>
          conflict.includes("prepare") &&
          conflict.includes("write operation") &&
          conflict.includes("only contribute command operations"),
      ),
      prepared.conflicts.join("\n"),
    );
  });
});

test("prepare rejects a non-object result without raw errors", async () => {
  await withTarget(async (target) => {
    for (const value of [null, "oops", 42, [{ conflicts: [] }]]) {
      const recipes = { web: recipeWithPrepare(async () => fragment(value)) };
      const prepared = await planComposition(inputFor(target, recipes, "web"));
      assert.equal(prepared.plan, undefined, JSON.stringify(value));
      assert.ok(
        prepared.conflicts.some((conflict) => conflict.includes("prepare")),
        prepared.conflicts.join("\n"),
      );
      assert.ok(
        prepared.conflicts.every(
          (conflict) => !/Cannot read properties|not iterable/.test(conflict),
        ),
        prepared.conflicts.join("\n"),
      );
    }
  });
});

test("finalize undefined and {} plan as empty fragments", async () => {
  await withTarget(async (target) => {
    for (const value of [undefined, {}]) {
      const recipes = { web: recipeWithFinalize(async () => fragment(value)) };
      const prepared = await planComposition(inputFor(target, recipes, "web"));
      assert.deepEqual(prepared.conflicts, [], JSON.stringify(value));
      assert.deepEqual(prepared.plan!.operations, []);
    }
  });
});

test("finalize with omitted fields normalizes to empty defaults", async () => {
  await withTarget(async (target) => {
    const recipes = { web: recipeWithFinalize(async () => fragment({ evidence: ["checked"] })) };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.deepEqual(prepared.conflicts, []);
    assert.deepEqual(prepared.plan!.operations, []);
    assert.ok(prepared.plan!.evidence.includes("checked"));
  });
});

test("finalize still plans a valid command operation", async () => {
  await withTarget(async (target) => {
    const recipes = {
      web: recipeWithFinalize(async (context) => {
        const cwd = context.cwd;
        return fragment({
          conflicts: [],
          evidence: [],
          operations: [
            {
              kind: "command",
              executable: process.execPath,
              args: ["-e", "process.exit(0)"],
              cwd,
              purpose: "Record application",
            },
          ],
        });
      }),
    };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.deepEqual(prepared.conflicts, []);
    assert.deepEqual(
      prepared.plan!.operations.map((operation) => operation.kind),
      ["command"],
    );
  });
});

test("finalize rejects write operations and unknown keys", async () => {
  await withTarget(async (target) => {
    const written = {
      web: recipeWithFinalize(async () =>
        fragment({
          operations: [{ kind: "write", path: join(target, "x"), before: null, after: "y" }],
        }),
      ),
    };
    const blockedWrite = await planComposition(inputFor(target, written, "web"));
    assert.equal(blockedWrite.plan, undefined);
    assert.ok(
      blockedWrite.conflicts.some(
        (conflict) =>
          conflict.includes("finalize") && conflict.includes("only contribute command operations"),
      ),
      blockedWrite.conflicts.join("\n"),
    );

    const unknown = {
      web: recipeWithFinalize(async () => fragment({ operations: [], extra: true })),
    };
    const blockedUnknown = await planComposition(inputFor(target, unknown, "web"));
    assert.equal(blockedUnknown.plan, undefined);
    assert.ok(
      blockedUnknown.conflicts.some(
        (conflict) => conflict.includes("finalize") && conflict.includes("unknown key(s): extra"),
      ),
      blockedUnknown.conflicts.join("\n"),
    );
  });
});

test("finalize rejects non-string args entries", async () => {
  await withTarget(async (target) => {
    const recipes = {
      web: recipeWithFinalize(async () =>
        fragment({
          operations: [
            {
              kind: "command",
              executable: process.execPath,
              args: ["-e", 42],
              cwd: target,
              purpose: "bad args",
            },
          ],
        }),
      ),
    };
    const prepared = await planComposition(inputFor(target, recipes, "web"));
    assert.equal(prepared.plan, undefined);
    assert.ok(
      prepared.conflicts.some(
        (conflict) => conflict.includes("finalize") && conflict.includes("args"),
      ),
      prepared.conflicts.join("\n"),
    );
  });
});

test("verify undefined and [] both mean success", async () => {
  await withTarget(async (target) => {
    for (const value of [undefined, []]) {
      const recipes: Record<string, Recipe> = {
        web: {
          name: "web",
          artifacts: [{ path: "package.json", contents: satisfiedManifest }],
          behavior: { verify: async () => failures(value) },
        },
      };
      assert.deepEqual(await verifyComposition(inputFor(target, recipes, "web")), []);
    }
  });
});

test("verify string failures aggregate across instances", async () => {
  await withTarget(async (target) => {
    const recipes: Record<string, Recipe> = {
      "child-a": {
        name: "child-a",
        artifacts: [
          {
            path: "package.json",
            contents: JSON.stringify({ dependencies: { "a-lib": "1.0.0" } }),
          },
        ],
        behavior: { verify: async () => ["a is broken"] },
      },
      "child-b": {
        name: "child-b",
        artifacts: [
          {
            path: "package.json",
            contents: JSON.stringify({ dependencies: { "b-lib": "2.0.0" } }),
          },
        ],
        behavior: { verify: async () => ["b is broken", "b is also broken"] },
      },
      parent: {
        name: "parent",
        artifacts: [],
        includes: [{ recipe: "child-a" }, { recipe: "child-b" }],
      },
    };
    await writeFile(
      join(target, "package.json"),
      JSON.stringify({ dependencies: { "a-lib": "1.0.0", "b-lib": "2.0.0" } }),
    );
    assert.deepEqual(await verifyComposition(inputFor(target, recipes, "parent")), [
      "a is broken",
      "b is broken",
      "b is also broken",
    ]);
  });
});

test("verify rejects non-array and non-string entries with the hook named", async () => {
  await withTarget(async (target) => {
    for (const value of ["oops", 42, ["fine", 42]]) {
      const recipes: Record<string, Recipe> = {
        web: {
          name: "web",
          artifacts: [{ path: "package.json", contents: satisfiedManifest }],
          behavior: { verify: async () => failures(value) },
        },
      };
      const result = await verifyComposition(inputFor(target, recipes, "web"));
      assert.equal(result.length, 1, JSON.stringify(value));
      assert.ok(result[0]!.includes("verify"), result[0]);
      assert.ok(!/not iterable/.test(result[0]!), result[0]);
    }
  });
});
