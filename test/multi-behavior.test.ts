import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyRecipeWithReplan,
  planComposition,
  verifyComposition,
  type CompositionInput,
  type Recipe,
  type RecipeBehavior,
} from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { executePlan, read } from "../src/runtime.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];
const root = resolve(".");
const script = join(root, "test", "fixtures", "init-scaffold.mjs");

type SeenVerify = { instance: string[]; artifacts: { path: string; contents: string }[] };

// Parent web over two behavior-bearing children and one artifact-only
// sibling. Child A prepares via the local initializer fixture and settles;
// child B's prepare is explicitly silent while its post-artifact plan
// contributes one deterministic local command. All three contribute
// different package.json state.
function multiBehaviorRecipes(seen: SeenVerify[]): Record<string, Recipe> {
  const verify =
    (store: SeenVerify[]) =>
    async (context: {
      cwd: string;
      instance: string[];
      artifacts: { path: string; contents: string }[];
    }): Promise<string[]> => {
      store.push({ instance: context.instance, artifacts: context.artifacts });
      return [];
    };
  const childA: RecipeBehavior = {
    prepare: async (context) => {
      if ((await context.read("package.json")) !== null)
        return { conflicts: [], evidence: ["a initializer output present"], operations: [] };
      return {
        conflicts: [],
        evidence: ["a plans the initializer first"],
        operations: [
          {
            kind: "command",
            executable: process.execPath,
            args: [script, context.cwd],
            cwd: context.cwd,
            purpose: "Generate initial project state with the local initializer fixture",
          },
        ],
      };
    },
    finalize: async () => ({
      conflicts: [],
      evidence: ["a has no post-artifact work"],
      operations: [],
    }),
    verify: verify(seen),
  };
  const childB: RecipeBehavior = {
    prepare: async () => ({ conflicts: [], evidence: ["b needs no preparation"], operations: [] }),
    // State-gated like a real behavior: the command runs once, then the
    // marker it creates settles future passes so verification can succeed.
    finalize: async (context) => {
      if ((await context.read("b-ready.txt")) !== null)
        return { conflicts: [], evidence: ["b post-artifact work done"], operations: [] };
      return {
        conflicts: [],
        evidence: ["b post-artifact check"],
        operations: [
          {
            kind: "command",
            executable: process.execPath,
            args: ["-e", 'require("node:fs").writeFileSync("b-ready.txt", "ready\\n")'],
            cwd: context.cwd,
            purpose: "Deterministic local post-artifact command from child B",
          },
        ],
      };
    },
    verify: verify(seen),
  };
  return {
    "child-a": {
      name: "child-a",
      behavior: childA,
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({ dependencies: { "child-a-lib": "1.0.0" } }),
        },
      ],
    },
    "child-b": {
      name: "child-b",
      behavior: childB,
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({ dependencies: { "child-b-lib": "2.0.0" } }),
        },
      ],
    },
    sibling: {
      name: "sibling",
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({ dependencies: { "sibling-lib": "3.0.0" } }),
        },
      ],
    },
    web: {
      name: "web",
      artifacts: [],
      includes: [{ recipe: "child-a" }, { recipe: "child-b" }, { recipe: "sibling" }],
    },
  };
}

function inputFor(cwd: string, recipes: Record<string, Recipe>): CompositionInput {
  return { cwd, recipes, entry: "web", invocation: [], handlers, read };
}

async function withTarget(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-multi-behavior-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("multi-behavior full workflow: prepare, replan, combined writes, one post command, both verifiers", async () => {
  await withTarget(async (cwd) => {
    const seen: SeenVerify[] = [];
    const recipes = multiBehaviorRecipes(seen);

    // PASS 1: only child A produces a prepare command; child B is silent.
    const first = await planComposition(inputFor(cwd, recipes));
    assert.deepEqual(first.conflicts, [], first.conflicts.join("\n"));
    const prep = first.plan!;
    assert.equal(prep.requiresReplan, true);
    assert.deepEqual(
      prep.operations.map((operation) => operation.kind),
      ["command"],
    );
    assert.ok(
      prep.evidence.some((line) => line.includes("initializer first")),
      prep.evidence.join("\n"),
    );
    assert.ok(
      prep.evidence.some((line) => line.includes("b needs no preparation")),
      prep.evidence.join("\n"),
    );
    const appliedFirst = await executePlan(prep);
    assert.equal(appliedFirst.status, "applied");

    // PASS 2: preparation settled, contributions combine, B commands last.
    const second = await planComposition(inputFor(cwd, recipes));
    assert.deepEqual(second.conflicts, [], second.conflicts.join("\n"));
    const plan = second.plan!;
    assert.equal(plan.requiresReplan, false);
    assert.deepEqual(
      plan.operations.map((operation) => operation.kind),
      ["write", "command"],
    );
    const write = plan.operations[0]!;
    assert.equal(write.kind, "write");
    if (write.kind !== "write") assert.fail("expected the package.json write first");
    assert.ok(write.path.endsWith("package.json"), write.path);
    const command = plan.operations[1]!;
    assert.equal(command.kind, "command");
    if (command.kind !== "command") assert.fail("expected child B command last");
    assert.equal(command.purpose, "Deterministic local post-artifact command from child B");
    const appliedSecond = await executePlan(plan);
    assert.equal(appliedSecond.status, "applied");

    // Generated state plus all three contributions, nothing overwritten.
    // SAFETY: the merged manifest carries dependency maps by handler construction.
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.deepEqual(manifest.dependencies, {
      "generated-lib": "1.0.0",
      "child-a-lib": "1.0.0",
      "child-b-lib": "2.0.0",
      "sibling-lib": "3.0.0",
    });
    assert.equal(manifest.scripts.start, "node index.js");

    // Both verifiers ran with their own instance identity and artifacts.
    const errors = await verifyComposition(inputFor(cwd, recipes));
    assert.deepEqual(errors, []);
    assert.equal(seen.length, 2);
    const byInstance = new Map(seen.map((entry) => [entry.instance.join(" > "), entry]));
    const seenA = byInstance.get("web > child-a")!;
    const seenB = byInstance.get("web > child-b")!;
    assert.deepEqual(seenA.artifacts, [
      {
        path: "package.json",
        contents: JSON.stringify({ dependencies: { "child-a-lib": "1.0.0" } }),
      },
    ]);
    assert.deepEqual(seenB.artifacts, [
      {
        path: "package.json",
        contents: JSON.stringify({ dependencies: { "child-b-lib": "2.0.0" } }),
      },
    ]);

    // Settled replan proposes nothing.
    const again = await planComposition(inputFor(cwd, recipes));
    assert.deepEqual(again.conflicts, []);
    assert.deepEqual(again.plan!.operations, []);
  });
});

test("verification failures aggregate across instances without skipping", async () => {
  await withTarget(async (cwd) => {
    const ran: string[] = [];
    const failing = (name: string, failure: string | null): RecipeBehavior => ({
      verify: async (context) => {
        ran.push(name);
        assert.deepEqual(context.instance[0], "web");
        return failure ? [failure] : [];
      },
    });
    const recipes: Record<string, Recipe> = {
      a: { name: "a", artifacts: [], behavior: failing("a", "a is unhappy") },
      b: { name: "b", artifacts: [], behavior: failing("b", null) },
      web: { name: "web", artifacts: [], includes: [{ recipe: "a" }, { recipe: "b" }] },
    };
    const errors = await verifyComposition(inputFor(cwd, recipes));
    assert.deepEqual(errors, ["a is unhappy"]);
    assert.deepEqual(ran.sort(), ["a", "b"]);
  });
});

test("two prepare command producers block without running either command", async () => {
  await withTarget(async (cwd) => {
    const preparing = (name: string): RecipeBehavior => ({
      prepare: async (context) => ({
        conflicts: [],
        evidence: [],
        operations: [
          {
            kind: "command",
            executable: process.execPath,
            args: [script, context.cwd, `--marker-${name}`],
            cwd: context.cwd,
            purpose: `prepare from ${name}`,
          },
        ],
      }),
    });
    const recipes: Record<string, Recipe> = {
      a: { name: "a", artifacts: [], behavior: preparing("a") },
      b: { name: "b", artifacts: [], behavior: preparing("b") },
      web: { name: "web", artifacts: [], includes: [{ recipe: "a" }, { recipe: "b" }] },
    };
    let reviews = 0;
    let executions = 0;
    const outcome = await applyRecipeWithReplan({
      planFresh: async () => {
        const prepared = await planComposition(inputFor(cwd, recipes));
        return {
          input: inputFor(cwd, recipes),
          plan: prepared.plan,
          conflicts: prepared.conflicts,
        };
      },
      review: async () => {
        reviews++;
        return true;
      },
      execute: async (plan) => {
        executions++;
        return executePlan(plan);
      },
      verify: async () => [],
    });
    assert.equal(outcome.status, "blocked");
    assert.equal(reviews, 0);
    assert.equal(executions, 0);
    if (outcome.status !== "blocked") assert.fail("expected a blocked outcome");
    assert.ok(
      outcome.conflicts.some(
        (conflict) =>
          conflict.includes("Multiple behavior-bearing recipe instances") &&
          conflict.includes("[web > a]") &&
          conflict.includes("[web > b]") &&
          conflict.includes("preparation command order is unsupported"),
      ),
      outcome.conflicts.join("\n"),
    );
  });
});

test("two settled post-artifact command producers block and keep no writes", async () => {
  await withTarget(async (cwd) => {
    const commanding = (name: string): RecipeBehavior => ({
      finalize: async (context) => ({
        conflicts: [],
        evidence: [],
        operations: [
          {
            kind: "command",
            executable: process.execPath,
            args: ["--version"],
            cwd: context.cwd,
            purpose: `post-artifact command from ${name}`,
          },
        ],
      }),
    });
    const recipes: Record<string, Recipe> = {
      a: {
        name: "a",
        behavior: commanding("a"),
        artifacts: [
          { path: "package.json", contents: JSON.stringify({ dependencies: { "a-lib": "1" } }) },
        ],
      },
      b: {
        name: "b",
        behavior: commanding("b"),
        artifacts: [
          { path: "package.json", contents: JSON.stringify({ dependencies: { "b-lib": "2" } }) },
        ],
      },
      web: { name: "web", artifacts: [], includes: [{ recipe: "a" }, { recipe: "b" }] },
    };
    const prepared = await planComposition(inputFor(cwd, recipes));
    assert.equal(prepared.plan, undefined);
    assert.ok(
      prepared.conflicts.some(
        (conflict) =>
          conflict.includes("Multiple behavior-bearing recipe instances") &&
          conflict.includes("[web > a]") &&
          conflict.includes("[web > b]") &&
          conflict.includes("post-artifact command order is unsupported"),
      ),
      prepared.conflicts.join("\n"),
    );
  });
});
