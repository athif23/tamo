import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { executePlan, read, type ApplyResult } from "../src/runtime.ts";
import { seedEffectRecipe } from "./effect-fixture.ts";
import type { Plan } from "../src/plan.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];
const root = resolve(".");
const script = join(root, "test", "fixtures", "init-scaffold.mjs");

// The upstream-CLI recipe: one behavior-bearing child whose prepare plans
// the initializer fixture while package.json is absent, plus semantic
// contributions to files the initializer generates. A sibling recipe
// contributes to the same package.json to prove combination still applies.
function scaffoldBehavior(options: { fail?: boolean; block?: boolean } = {}): RecipeBehavior {
  return {
    prepare: async (context) => {
      if (options.block)
        return { conflicts: ["simulated preparation conflict"], evidence: [], operations: [] };
      if ((await context.read("package.json")) !== null)
        return {
          conflicts: [],
          evidence: ["initializer output already present"],
          operations: [],
        };
      return {
        conflicts: [],
        evidence: ["target has no package.json; planning the initializer first"],
        operations: [
          {
            kind: "command",
            executable: process.execPath,
            args: options.fail ? [script, context.cwd, "--fail"] : [script, context.cwd],
            cwd: context.cwd,
            purpose: "Generate initial project state with the upstream initializer fixture",
          },
        ],
      };
    },
  };
}

function scaffoldRecipes(
  options: { fail?: boolean; block?: boolean; clash?: boolean } = {},
): Record<string, Recipe> {
  return {
    scaffold: {
      name: "scaffold",
      behavior: scaffoldBehavior(options),
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({
            dependencies: options.clash ? { "generated-lib": "9.9.9" } : { "recipe-lib": "2.0.0" },
          }),
        },
        {
          path: ".oxlintrc.jsonc",
          contents: JSON.stringify({ rules: { "recipe-rule": "error" } }),
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
      includes: [{ recipe: "scaffold" }, { recipe: "sibling" }],
    },
  };
}

function inputFor(cwd: string, recipes: Record<string, Recipe>): CompositionInput {
  return { cwd, recipes, entry: "web", invocation: [], handlers, read };
}

async function withTarget(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-prepare-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("A: absent generated state plans the initializer only, with requiresReplan", async () => {
  await withTarget(async (cwd) => {
    const prepared = await planComposition(inputFor(cwd, scaffoldRecipes()));
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    const plan = prepared.plan!;
    assert.equal(plan.requiresReplan, true);
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.operations[0]!.kind, "command");
    assert.deepEqual(
      plan.operations.filter((operation) => operation.kind === "write"),
      [],
      "the preparation plan must not pretend to know the downstream diff",
    );
    // SAFETY: JSON round-trip preserves the plan object shape under test control.
    const exposed = JSON.parse(JSON.stringify({ plan })) as { plan: Plan };
    assert.equal(exposed.plan.requiresReplan, true);
    // The preparation read is a reviewed input of this plan alone: creating
    // package.json behind its back fails the recheck instead of executing.
    assert.ok(
      plan.inputs.some((input) => input.path.endsWith("package.json")),
      JSON.stringify(plan.inputs),
    );
  });
});

test("preparation conflicts block with zero operations", async () => {
  await withTarget(async (cwd) => {
    const prepared = await planComposition(inputFor(cwd, scaffoldRecipes({ block: true })));
    assert.ok(
      prepared.conflicts.some((conflict) => conflict.includes("simulated preparation")),
      prepared.conflicts.join("\n"),
    );
    assert.equal(prepared.plan, undefined);
  });
});

test("B+C+D: initializer, fresh replan, and combined writes preserve generated state", async () => {
  await withTarget(async (cwd) => {
    const recipes = scaffoldRecipes();
    const first = await planComposition(inputFor(cwd, recipes));
    const applied = await executePlan(first.plan!);
    assert.equal(applied.status, "applied");

    // Fresh planning pass from scratch: new resolution, reads, snapshots.
    const second = await planComposition(inputFor(cwd, recipes));
    assert.deepEqual(second.conflicts, [], second.conflicts.join("\n"));
    const plan = second.plan!;
    assert.equal(plan.requiresReplan, false);
    assert.ok(plan.operations.length > 0);
    assert.ok(
      plan.operations.every((operation) => operation.kind === "write"),
      "the initializer is gone and the fixture plans no post-artifact commands",
    );

    // Both recipe contributions combined before meeting the generated target.
    assert.ok(
      plan.evidence.some((line) =>
        line.includes("combined 2 contributions from [web > scaffold], [web > sibling]"),
      ),
      plan.evidence.join("\n"),
    );
    const secondApplied = await executePlan(plan);
    assert.equal(secondApplied.status, "applied");

    // SAFETY: the generated manifest shape is fixed by the test fixture script.
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.deepEqual(manifest.dependencies, {
      "generated-lib": "1.0.0",
      "recipe-lib": "2.0.0",
      "sibling-lib": "3.0.0",
    });
    assert.equal(manifest.scripts.start, "node index.js");
    // SAFETY: the generated config shape is fixed by the test fixture script.
    const config = JSON.parse(await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8")) as {
      rules: Record<string, string>;
    };
    assert.deepEqual(config.rules, { "generated-rule": "warn", "recipe-rule": "error" });
  });
});

test("E: dry-run executes nothing and fabricates no downstream writes", async () => {
  await withTarget(async (cwd) => {
    const prepared = await planComposition(inputFor(cwd, scaffoldRecipes()));
    const plan = prepared.plan!;
    // Dry-run honesty by construction: review without execution.
    let packageExists = true;
    try {
      await readFile(join(cwd, "package.json"), "utf8");
    } catch {
      packageExists = false;
    }
    assert.equal(packageExists, false);
    assert.equal(plan.requiresReplan, true);
    assert.deepEqual(
      plan.operations.filter((operation) => operation.kind === "write"),
      [],
    );
  });
});

function runCli(args: string[], home: string, cwd: string) {
  const result = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, TAMO_HOME: home },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("E: real CLI JSON exposes requiresReplan on a single-stage recipe", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-prepare-cli-"));
  const home = await mkdtemp(join(tmpdir(), "tamo-prepare-home-"));
  try {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "sample",
        packageManager: "pnpm@10.11.0",
        dependencies: { effect: "4.0.0-rc.112" },
        devDependencies: { oxlint: "1.80.0" },
      }),
    );
    await writeFile(join(cwd, ".oxlintrc.jsonc"), `{"rules":{}}`);
    for (const name of ["effect", "oxlint"]) {
      await mkdir(join(cwd, "node_modules", name), { recursive: true });
      await writeFile(
        join(cwd, "node_modules", name, "package.json"),
        JSON.stringify({ version: name === "effect" ? "4.0.0-rc.112" : "1.80.0" }),
      );
    }
    await seedEffectRecipe(home);
    const dry = runCli(["add", "effect-oxlint", "--cwd", cwd, "--json", "--dry-run"], home, cwd);
    assert.equal(dry.code, 0, dry.stderr);
    // SAFETY: the CLI prints a JSON object with the reviewed plan under the plan key.
    const preview = JSON.parse(dry.stdout) as { plan: Plan };
    assert.equal(preview.plan.requiresReplan, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("F: the full workflow ends idempotent through the staged orchestration", async () => {
  await withTarget(async (cwd) => {
    const recipes = scaffoldRecipes();
    let plans = 0;
    const outcome = await applyRecipeWithReplan({
      planFresh: async () => {
        plans++;
        const input = inputFor(cwd, recipes);
        const prepared = await planComposition(input);
        return { input, plan: prepared.plan, conflicts: prepared.conflicts };
      },
      review: async () => true,
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyComposition(input),
    });
    assert.equal(outcome.status, "applied");
    assert.equal(plans, 2, "one preparation plan plus one fresh replan");
    if (outcome.status !== "applied") assert.fail("expected an applied outcome");
    assert.equal(outcome.completed.length, 2);
    const first = outcome.completed[0]!;
    const second = outcome.completed[1]!;
    assert.equal(first.plan.requiresReplan, true);
    assert.deepEqual(
      first.plan.operations.map((operation) => operation.kind),
      ["command"],
    );
    assert.equal(second.plan.requiresReplan, false);
    assert.ok(second.plan.operations.every((operation) => operation.kind === "write"));

    const again = await planComposition(inputFor(cwd, recipes));
    assert.deepEqual(again.conflicts, [], again.conflicts.join("\n"));
    assert.deepEqual(again.plan!.operations, [], "no preparation command and no writes repeat");
    assert.equal(again.plan!.requiresReplan, false);
  });
});

test("G: a failed initializer stops before any replan", async () => {
  await withTarget(async (cwd) => {
    const recipes = scaffoldRecipes({ fail: true });
    let plans = 0;
    const outcome = await applyRecipeWithReplan({
      planFresh: async () => {
        plans++;
        const input = inputFor(cwd, recipes);
        const prepared = await planComposition(input);
        return { input, plan: prepared.plan, conflicts: prepared.conflicts };
      },
      review: async () => true,
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyComposition(input),
    });
    assert.equal(outcome.status, "failed");
    assert.equal(plans, 1, "no second planning pass after a failed preparation");
    let packageExists = true;
    try {
      await readFile(join(cwd, "package.json"), "utf8");
    } catch {
      packageExists = false;
    }
    assert.equal(packageExists, false);
  });
});

test("G: a second-stage conflict surfaces after first-stage success without rollback", async () => {
  await withTarget(async (cwd) => {
    const recipes = scaffoldRecipes({ clash: true });
    const outcome = await applyRecipeWithReplan({
      planFresh: async () => {
        const input = inputFor(cwd, recipes);
        const prepared = await planComposition(input);
        return { input, plan: prepared.plan, conflicts: prepared.conflicts };
      },
      review: async () => true,
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyComposition(input),
    });
    assert.equal(outcome.status, "blocked");
    if (outcome.status !== "blocked") assert.fail("expected a blocked outcome");
    assert.ok(
      outcome.conflicts.some((conflict) => conflict.includes("generated-lib")),
      outcome.conflicts.join("\n"),
    );
    // The successfully generated first stage is left in place, unmodified.
    // SAFETY: the generated manifest shape is fixed by the test fixture script.
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.deepEqual(manifest.dependencies, { "generated-lib": "1.0.0" });
  });
});

test("orchestration stops when preparation never settles", async () => {
  const unsettled: Plan = {
    subject: "recipe:restless",
    cwd: "restless",
    inputs: [],
    evidence: [],
    conflicts: [],
    operations: [
      {
        kind: "command",
        executable: process.execPath,
        args: ["--version"],
        cwd: "restless",
        purpose: "always plans again",
      },
    ],
    validation: [],
    requiresReplan: true,
  };
  const applied: ApplyResult = { status: "applied", completed: [], remaining: [], errors: [] };
  let plans = 0;
  const input: CompositionInput = {
    cwd: "restless",
    recipes: {},
    entry: "x",
    invocation: [],
    handlers,
    read,
  };
  const outcome = await applyRecipeWithReplan({
    planFresh: async () => {
      plans++;
      return { input, conflicts: [], plan: unsettled };
    },
    review: async () => true,
    execute: async () => applied,
    verify: async () => [],
  });
  assert.equal(outcome.status, "blocked");
  assert.equal(plans, 2, "one checkpoint, then stop instead of looping");
  if (outcome.status !== "blocked") assert.fail("expected a blocked outcome");
  assert.ok(
    outcome.conflicts.some((conflict) => conflict.includes("single preparation checkpoint")),
    outcome.conflicts.join("\n"),
  );
});
