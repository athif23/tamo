import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { planComposition, type CompositionInput } from "../src/compose.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { loadRecipeTree, mergeSnapshots } from "../src/recipes.ts";
import { planCreate } from "../src/create.ts";
import { executePlan, read } from "../src/runtime.ts";
import type { Plan } from "../src/plan.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];
const root = resolve(".");

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tamo-inputs-home-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withTarget(run: (target: string) => Promise<void>): Promise<void> {
  const target = await mkdtemp(join(tmpdir(), "tamo-inputs-target-"));
  try {
    await run(target);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "tamo-inputs-ws-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function writeRecipe(
  home: string,
  name: string,
  options: { recipeJson?: string; behaviorMjs?: string; artifacts?: Record<string, string> },
): Promise<void> {
  const dir = join(home, "recipes", name);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await writeFile(join(dir, "recipe.json"), options.recipeJson ?? "{}\n");
  for (const [path, contents] of Object.entries(options.artifacts ?? {})) {
    const absolute = join(dir, "artifacts", path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  if (options.behaviorMjs !== undefined)
    await writeFile(join(dir, "behavior.mjs"), options.behaviorMjs);
}

function under(home: string, name: string, input: { path: string }): boolean {
  return input.path.startsWith(join(home, "recipes", name) + sep);
}

function runAddDryRunRaw(target: string, home: string, recipe: string) {
  const result = spawnSync(
    process.execPath,
    [join(root, "src/cli.ts"), "add", recipe, "--cwd", target, "--json", "--dry-run"],
    {
      cwd: root,
      env: { ...process.env, TAMO_HOME: home },
      encoding: "utf8",
    },
  );
  // SAFETY: CLI dry-run JSON is { plan } by contract under test control.
  const parsed = JSON.parse(result.stdout) as { plan: Plan };
  return { code: result.status ?? -1, plan: parsed.plan, stderr: result.stderr };
}

function runAddDryRun(target: string, home: string, recipe: string): Plan {
  const raw = runAddDryRunRaw(target, home, recipe);
  assert.equal(raw.code, 0, raw.stderr);
  return raw.plan;
}

// Mirror the production reviewed-plan assembly: demand-first tree loading
// plus Core planning. Tests use the same loader as src/cli.ts so they fail
// if planning regresses to eager all-recipe loading.
async function reviewedAddPlan(
  home: string,
  target: string,
  entry: string,
): Promise<{ plan: Plan; input: CompositionInput }> {
  const loaded = await loadRecipeTree(home, entry);
  assert.deepEqual(loaded.conflicts, []);
  const input: CompositionInput = {
    cwd: target,
    recipes: loaded.recipes,
    entry,
    invocation: [],
    handlers,
    read,
  };
  const prepared = await planComposition(input);
  assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
  const plan = prepared.plan!;
  plan.inputs = mergeSnapshots(plan.inputs, loaded.snapshots);
  return { plan, input };
}

test("A: unrelated invalid metadata does not poison selected add", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "selected", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "selected-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "unrelated", { recipeJson: '{"unknownKey":true}\n' });
    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { plan } = await reviewedAddPlan(home, target, "selected");
      assert.ok(plan.operations.length > 0);
      assert.equal(
        plan.inputs.filter((input) => under(home, "unrelated", input)).length,
        0,
        JSON.stringify(plan.inputs.map((input) => input.path)),
      );
      const cliPlan = runAddDryRun(target, home, "selected");
      assert.deepEqual(cliPlan.conflicts, []);
      assert.ok(cliPlan.operations.length > 0);
      assert.equal(
        cliPlan.inputs.filter((input) => under(home, "unrelated", input)).length,
        0,
        JSON.stringify(cliPlan.inputs.map((input) => input.path)),
      );
    });
  });
});

test("B: unrelated invalid metadata does not poison selected create", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "selected", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "selected-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "unrelated", { recipeJson: '{"unknownKey":true}\n' });
    await withWorkspace(async (workspace) => {
      const prepared = await planCreate(home, workspace, "new-app", "selected");
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      assert.ok(prepared.plan!.operations.length > 0);
      assert.equal(
        prepared.plan!.inputs.filter((input) => under(home, "unrelated", input)).length,
        0,
        JSON.stringify(prepared.plan!.inputs.map((input) => input.path)),
      );
    });
  });
});

test("C: invalid metadata in the selected recipe still blocks", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "selected", { recipeJson: '{"unknownKey":true}\n' });
    await writeRecipe(home, "unrelated", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "unrelated-lib": "1.0.0" } }) },
    });
    const loaded = await loadRecipeTree(home, "selected");
    assert.ok(
      loaded.conflicts.some((conflict) => conflict.includes("unknownKey")),
      loaded.conflicts.join("\n"),
    );
    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const raw = runAddDryRunRaw(target, home, "selected");
      assert.equal(raw.code, 1, JSON.stringify(raw.plan));
      assert.ok(
        raw.plan.conflicts.some((conflict) => conflict.includes("unknownKey")),
        raw.plan.conflicts.join("\n"),
      );
    });
  });
});

test("D: invalid metadata in an included recipe still blocks", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "child", { recipeJson: '{"unknownKey":true}\n' });
    await writeRecipe(home, "parent", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "child" }] }),
      artifacts: { "notes.md": "parent\n" },
    });
    await writeRecipe(home, "unrelated", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "unrelated-lib": "1.0.0" } }) },
    });
    const loaded = await loadRecipeTree(home, "parent");
    assert.ok(
      loaded.conflicts.some((conflict) => conflict.includes("unknownKey")),
      loaded.conflicts.join("\n"),
    );
    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const raw = runAddDryRunRaw(target, home, "parent");
      assert.equal(raw.code, 1, JSON.stringify(raw.plan));
      assert.ok(
        raw.plan.conflicts.some((conflict) => conflict.includes("unknownKey")),
        raw.plan.conflicts.join("\n"),
      );
    });
  });
});

test("E: unrelated malformed includes metadata is never parsed", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "selected", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "selected-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "unrelated", {
      recipeJson: '{"includes":[{"recipe":"child","as":"alias"}]}\n',
    });
    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { plan } = await reviewedAddPlan(home, target, "selected");
      assert.ok(plan.operations.length > 0);
      const cliPlan = runAddDryRun(target, home, "selected");
      assert.deepEqual(cliPlan.conflicts, []);
    });
  });
});

test("F: recursive includes load transitively", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "grandchild", {
      artifacts: {
        "package.json": JSON.stringify({ dependencies: { "grandchild-lib": "1.0.0" } }),
      },
    });
    await writeRecipe(home, "child", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "grandchild" }] }),
      artifacts: { "package.json": JSON.stringify({ dependencies: { "child-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "parent", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "child" }] }),
      artifacts: { "package.json": JSON.stringify({ dependencies: { "parent-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "unrelated", { recipeJson: '{"unknownKey":true}\n' });
    const loaded = await loadRecipeTree(home, "parent");
    assert.deepEqual(loaded.conflicts, []);
    assert.deepEqual(Object.keys(loaded.recipes).sort(), ["child", "grandchild", "parent"]);
    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { plan } = await reviewedAddPlan(home, target, "parent");
      assert.deepEqual(plan.conflicts, []);
      for (const name of ["parent", "child", "grandchild"])
        assert.ok(
          plan.inputs.some((input) => under(home, name, input)),
          `${name}: ${JSON.stringify(plan.inputs.map((input) => input.path))}`,
        );
    });
  });
});

test("G: include cycles terminate and report the existing cycle conflict", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "a", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "b" }] }),
    });
    await writeRecipe(home, "b", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "a" }] }),
    });
    const loaded = await loadRecipeTree(home, "a");
    assert.deepEqual(loaded.conflicts, [], loaded.conflicts.join("\n"));
    assert.deepEqual(Object.keys(loaded.recipes).sort(), ["a", "b"]);
    await withTarget(async (target) => {
      const raw = runAddDryRunRaw(target, home, "a");
      assert.equal(raw.code, 1, JSON.stringify(raw.plan));
      assert.ok(
        raw.plan.conflicts.some((conflict) => conflict.includes("cycle")),
        raw.plan.conflicts.join("\n"),
      );
    });
  });
});

test("H: missing included recipes report a clear unknown-recipe conflict", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "parent", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "missing" }] }),
    });
    const loaded = await loadRecipeTree(home, "parent");
    assert.ok(
      loaded.conflicts.some((conflict) => conflict.includes("Unknown recipe: missing")),
      loaded.conflicts.join("\n"),
    );
    await withTarget(async (target) => {
      const raw = runAddDryRunRaw(target, home, "parent");
      assert.equal(raw.code, 1, JSON.stringify(raw.plan));
      assert.ok(
        raw.plan.conflicts.some((conflict) => conflict.includes("Unknown recipe: missing")),
        raw.plan.conflicts.join("\n"),
      );
    });
  });
});

test("I: unrelated recipe files stay excluded from reviewed inputs", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "selected", {
      behaviorMjs: "export default { verify: async () => [] };\n",
      artifacts: { "package.json": JSON.stringify({ dependencies: { "selected-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "unrelated", {
      behaviorMjs: "export default {oops\n",
      artifacts: {
        "package.json": JSON.stringify({ dependencies: { "unrelated-lib": "9.9.9" } }),
        "unrelated.txt": "unrelated\n",
      },
    });

    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { plan } = await reviewedAddPlan(home, target, "selected");
      assert.ok(plan.operations.length > 0);
      assert.ok(
        plan.inputs.some((input) => input.path.endsWith(join("selected", "recipe.json"))),
        JSON.stringify(plan.inputs.map((input) => input.path)),
      );
      assert.ok(
        plan.inputs.some((input) => input.path.endsWith(join("selected", "behavior.mjs"))),
        JSON.stringify(plan.inputs.map((input) => input.path)),
      );
      assert.equal(
        plan.inputs.filter((input) => under(home, "unrelated", input)).length,
        0,
        JSON.stringify(plan.inputs.map((input) => input.path)),
      );
      assert.ok(
        plan.inputs.some((input) => input.path === join(target, "package.json")),
        JSON.stringify(plan.inputs.map((input) => input.path)),
      );
    });

    await withWorkspace(async (workspace) => {
      // Unrelated stays invalid-shaped here on purpose: tree loading must
      // not parse it for the selected create plan either.
      await writeFile(join(home, "recipes", "unrelated", "recipe.json"), '{"unknownKey":true}\n');
      const prepared = await planCreate(home, workspace, "new-app", "selected");
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      assert.equal(
        prepared.plan!.inputs.filter((input) => under(home, "unrelated", input)).length,
        0,
        JSON.stringify(prepared.plan!.inputs.map((input) => input.path)),
      );
      await writeFile(join(home, "recipes", "unrelated", "recipe.json"), "{}\n");
    });

    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const plan = runAddDryRun(target, home, "selected");
      assert.equal(
        plan.inputs.filter((input) => under(home, "unrelated", input)).length,
        0,
        JSON.stringify(plan.inputs.map((input) => input.path)),
      );
    });
  });
});

test("J: parent plus included children stay tracked", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "child-a", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "child-a-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "child-b", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "child-b-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "parent", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "child-a" }, { recipe: "child-b" }] }),
      artifacts: { "package.json": JSON.stringify({ dependencies: { "parent-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "unrelated", { recipeJson: '{"unknownKey":true}\n' });

    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { plan } = await reviewedAddPlan(home, target, "parent");
      assert.deepEqual(plan.conflicts, []);
      for (const name of ["parent", "child-a", "child-b"])
        assert.ok(
          plan.inputs.some((input) => under(home, name, input)),
          `${name}: ${JSON.stringify(plan.inputs.map((input) => input.path))}`,
        );
      assert.equal(
        plan.inputs.filter((input) => under(home, "unrelated", input)).length,
        0,
        JSON.stringify(plan.inputs.map((input) => input.path)),
      );
    });
  });
});

test("K: unrelated mutation does not invalidate, selected/included mutations do", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "child", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "child-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "selected", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "child" }] }),
      artifacts: { "package.json": JSON.stringify({ dependencies: { "selected-lib": "1.0.0" } }) },
    });
    await writeRecipe(home, "unrelated", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "unrelated-lib": "1.0.0" } }) },
    });
    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { plan } = await reviewedAddPlan(home, target, "selected");
      assert.ok(plan.operations.length > 0);
      await writeFile(
        join(home, "recipes", "unrelated", "artifacts", "package.json"),
        JSON.stringify({ dependencies: { "unrelated-lib": "2.0.0" } }),
      );
      const unrelatedResult = await executePlan(plan);
      assert.equal(unrelatedResult.status, "applied", JSON.stringify(unrelatedResult.errors));
    });

    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { plan } = await reviewedAddPlan(home, target, "selected");
      await writeFile(
        join(home, "recipes", "selected", "artifacts", "package.json"),
        JSON.stringify({ dependencies: { "selected-lib": "2.0.0" } }),
      );
      const before = await readFile(join(target, "package.json"), "utf8");
      const result = await executePlan(plan);
      assert.equal(result.status, "failed");
      assert.ok(result.errors.some((error) => error.includes("Input changed")));
      assert.equal(await readFile(join(target, "package.json"), "utf8"), before);
      await writeFile(
        join(home, "recipes", "selected", "artifacts", "package.json"),
        JSON.stringify({ dependencies: { "selected-lib": "1.0.0" } }),
      );
    });

    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { plan } = await reviewedAddPlan(home, target, "selected");
      await writeFile(
        join(home, "recipes", "child", "artifacts", "package.json"),
        JSON.stringify({ dependencies: { "child-lib": "2.0.0" } }),
      );
      const result = await executePlan(plan);
      assert.equal(result.status, "failed");
      assert.ok(result.errors.some((error) => error.includes("Input changed")));
    });
  });
});

test("L: unrelated broken behavior remains ignored", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "broken", { behaviorMjs: "export default {oops\n" });
    await writeRecipe(home, "ok", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "ok-lib": "1.0.0" } }) },
    });
    const loaded = await loadRecipeTree(home, "ok");
    assert.deepEqual(loaded.conflicts, []);
    assert.deepEqual(Object.keys(loaded.recipes), ["ok"]);
    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const plan = runAddDryRun(target, home, "ok");
      assert.deepEqual(plan.conflicts, []);
      assert.ok(plan.operations.length > 0);
    });
  });
});
