import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { seedEffectRecipe, versions } from "./effect-fixture.ts";
import {
  applyRecipeWithReplan,
  planComposition,
  verifyComposition,
  type CompositionInput,
  type Recipe,
} from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { packRecipe } from "../src/pack.ts";
import { planCreate, verifyCreate } from "../src/create.ts";
import { loadAllRecipes, loadRecipe, saveRecipe } from "../src/recipes.ts";
import { executePlan, read } from "../src/runtime.ts";
import type { Plan } from "../src/plan.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];
const root = resolve(".");
const nodeBin = JSON.stringify(process.execPath);
const initScript = JSON.stringify(join(root, "test", "fixtures", "init-scaffold.mjs"));
const markerScript = JSON.stringify(
  `require("node:fs").writeFileSync("fx-effect.done", "done\\n")`,
);

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tamo-durable-home-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withTarget(run: (target: string) => Promise<void>): Promise<void> {
  const target = await mkdtemp(join(tmpdir(), "tamo-durable-target-"));
  try {
    await run(target);
  } finally {
    await rm(target, { recursive: true, force: true });
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

// prepare-only durable behavior: runs the local initializer fixture while
// the target has no package.json, then settles. Dependency-free — the
// contract needs no Tamo imports, only the passed context.
function fxInitBehavior(): string {
  return `\
const node = ${nodeBin};
const initializer = ${initScript};
export default {
  prepare: async (context) => {
    if ((await context.read("package.json")) !== null)
      return { conflicts: [], evidence: ["fx-init output present"], operations: [] };
    // The initializer creates the target itself, so the command runs from
    // the existing parent workspace — never from the not-yet-existing
    // target. This keeps one fixture usable for both add (target exists)
    // and create (target absent until the initializer runs).
    const { dirname } = await import("node:path");
    return {
      conflicts: [],
      evidence: ["fx-init plans the initializer first"],
      operations: [
        {
          kind: "command",
          executable: node,
          args: [initializer, context.cwd],
          cwd: dirname(context.cwd),
          purpose: "Generate fixture project state",
        },
      ],
    };
  },
  verify: async (context) => {
    if (context.instance[context.instance.length - 1] !== "fx-init")
      return ["fx-init verifier saw foreign instance " + context.instance.join(" > ")];
    const found = context.artifacts.some((artifact) => artifact.path === "package.json");
    if (!found) return ["fx-init resolved intent carries no package.json contribution"];
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      await readFile(join(context.cwd, "package.json"), "utf8");
    } catch {
      return ["fx-init target package.json missing: initializer did not run"];
    }
    return [];
  },
};
`;
}

// Effect-style durable behavior, adapted dependency-free: pinned
// preconditions are checked against actual target state (mirroring the
// in-memory behavior's precondition-vs-recipe separation), a state-gated
// command records application, and verification asserts intent plus effect.
function fxEffectBehavior(): string {
  return `\
const node = ${nodeBin};
const PRECONDITIONS = { "generated-lib": "1.0.0" };
const MARKER = "fx-effect.done";
const markerScript = ${markerScript};
export default {
  finalize: async (context) => {
    const conflicts = [];
    const evidence = [];
    const operations = [];
    const text = await context.read("package.json");
    if (text === null) {
      conflicts.push("fx-effect requires package.json in the target.");
      return { conflicts, evidence, operations };
    }
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      conflicts.push("fx-effect: target package.json is not valid JSON.");
      return { conflicts, evidence, operations };
    }
    const declared = Object.assign({}, manifest.dependencies, manifest.devDependencies);
    for (const name of Object.keys(PRECONDITIONS)) {
      const version = PRECONDITIONS[name];
      if (typeof declared[name] !== "string")
        conflicts.push("fx-effect requires " + name + " declared in the target.");
      else if (declared[name] !== version)
        conflicts.push(name + ": expected " + version + ", found " + declared[name] + ". No automatic upgrade.");
      else evidence.push(name + " " + version + " declared");
    }
    if (conflicts.length) return { conflicts, evidence, operations };
    if ((await context.read(MARKER)) !== null) return { conflicts, evidence, operations };
    operations.push({
      kind: "command",
      executable: node,
      args: ["-e", markerScript],
      cwd: context.cwd,
      purpose: "Record fx-effect application",
    });
    return { conflicts, evidence, operations };
  },
  verify: async (context) => {
    if (context.instance[context.instance.length - 1] !== "fx-effect")
      return ["fx-effect verifier saw foreign instance " + context.instance.join(" > ")];
    const found = context.artifacts.some((artifact) => artifact.path === "package.json");
    if (!found) return ["fx-effect resolved intent carries no package.json contribution"];
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      await readFile(join(context.cwd, MARKER), "utf8");
    } catch {
      return ["fx-effect marker missing: finalize command did not run"];
    }
    return [];
  },
};
`;
}

const fxInitManifest = JSON.stringify({ dependencies: { "fx-init-lib": "1.0.0" } });
const fxEffectManifest = JSON.stringify({
  dependencies: { "generated-lib": "1.0.0", "fx-effect-lib": "2.0.0" },
});
const siblingManifest = JSON.stringify({ dependencies: { "sibling-lib": "3.0.0" } });
const siblingConfig = JSON.stringify({ rules: { "sibling-rule": "error" } });

async function writeComposition(home: string): Promise<void> {
  await writeRecipe(home, "fx-init", {
    behaviorMjs: fxInitBehavior(),
    artifacts: { "package.json": fxInitManifest },
  });
  await writeRecipe(home, "fx-effect", {
    behaviorMjs: fxEffectBehavior(),
    artifacts: { "package.json": fxEffectManifest },
  });
  await writeRecipe(home, "sibling", {
    artifacts: { "package.json": siblingManifest, ".oxlintrc.jsonc": siblingConfig },
  });
  await writeRecipe(home, "fx-web", {
    recipeJson: JSON.stringify({
      includes: [{ recipe: "fx-init" }, { recipe: "fx-effect" }, { recipe: "sibling" }],
    }),
  });
}

function inputFor(target: string, recipes: Record<string, Recipe>): CompositionInput {
  return { cwd: target, recipes, entry: "fx-web", invocation: [], handlers, read };
}

function runCli(args: string[], home: string) {
  const result = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, TAMO_HOME: home },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("artifact-only durable recipes load without behavior and plan unchanged", async () => {
  await withHome(async (home) => {
    await saveRecipe(home, "plain", [{ path: "package.json", contents: siblingManifest }]);
    const before = await loadRecipe(home, "plain");
    assert.deepEqual(before.conflicts, []);
    assert.equal("behaviorFile" in before.recipe!, false);
    assert.ok(before.snapshots.every((snapshot) => !snapshot.path.endsWith("behavior.mjs")));

    // A packed-style directory accepts a hand-added behavior module beside
    // recipe.json; the loader detects it without importing it.
    await writeFile(
      join(home, "recipes", "plain", "behavior.mjs"),
      "export default { verify: async () => [] };",
    );
    const after = await loadRecipe(home, "plain");
    assert.deepEqual(after.conflicts, []);
    assert.ok(after.recipe!.behaviorFile!.endsWith(join("plain", "behavior.mjs")));
    assert.equal(after.recipe!.behavior, undefined);
    assert.ok(after.snapshots.some((snapshot) => snapshot.path.endsWith("behavior.mjs")));
  });
});

test("durable prepare composition runs end to end through Core orchestration", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      await writeComposition(home);
      const plans: Plan[] = [];
      const outcome = await applyRecipeWithReplan({
        planFresh: async () => {
          const loaded = await loadAllRecipes(home);
          if (loaded.conflicts.length) return { conflicts: loaded.conflicts };
          const input = inputFor(target, loaded.recipes);
          const prepared = await planComposition(input);
          return { input, plan: prepared.plan, conflicts: prepared.conflicts };
        },
        review: async (plan) => {
          plans.push(plan);
          return true;
        },
        execute: (plan) => executePlan(plan),
        verify: (input) => verifyComposition(input),
      });
      assert.equal(outcome.status, "applied");
      assert.equal(plans.length, 2);

      const first = plans[0]!;
      assert.equal(first.requiresReplan, true);
      assert.deepEqual(
        first.operations.map((operation) => operation.kind),
        ["command"],
      );
      const initializer = first.operations[0]!;
      assert.equal(initializer.kind, "command");
      if (initializer.kind !== "command") assert.fail("expected the initializer command");
      assert.ok(
        initializer.args.some((arg) => arg.endsWith("init-scaffold.mjs")),
        initializer.args.join(" "),
      );

      const second = plans[1]!;
      assert.equal(second.requiresReplan, false);
      const kinds = second.operations.map((operation) => operation.kind);
      assert.deepEqual(kinds, ["write", "write", "command"]);
      const last = second.operations[second.operations.length - 1]!;
      assert.equal(last.kind, "command");
      if (last.kind !== "command") assert.fail("expected the finalize command last");
      assert.equal(last.purpose, "Record fx-effect application");

      // SAFETY: the merged manifest carries dependency maps by handler construction.
      const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
        scripts: Record<string, string>;
      };
      assert.deepEqual(manifest.dependencies, {
        "generated-lib": "1.0.0",
        "fx-init-lib": "1.0.0",
        "fx-effect-lib": "2.0.0",
        "sibling-lib": "3.0.0",
      });
      assert.equal(manifest.scripts.start, "node index.js");
      // SAFETY: the merged config carries a rules map by handler construction.
      const config = JSON.parse(await readFile(join(target, ".oxlintrc.jsonc"), "utf8")) as {
        rules: Record<string, string>;
      };
      assert.deepEqual(config.rules, { "generated-rule": "warn", "sibling-rule": "error" });
      assert.equal(
        await readFile(join(target, "fx-effect.done"), "utf8").catch(() => null),
        "done\n",
      );

      // Applied outcome means both self-checking verifiers saw their own
      // instance identity and artifacts; a settled replan proposes nothing.
      const input = inputFor(target, (await loadAllRecipes(home)).recipes);
      const again = await planComposition(input);
      assert.deepEqual(again.conflicts, []);
      assert.deepEqual(again.plan!.operations, []);
      assert.equal(again.plan!.requiresReplan, false);
    });
  });
});

test("durable Effect-style finalize settles, conflicts, and requires its target", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "fx-effect", {
      behaviorMjs: fxEffectBehavior(),
      artifacts: { "package.json": fxEffectManifest },
    });
    const recipes = (await loadAllRecipes(home)).recipes;
    const inputForEffect = (target: string): CompositionInput => ({
      cwd: target,
      recipes,
      entry: "fx-effect",
      invocation: [],
      handlers,
      read,
    });

    // Missing package.json blocks through the behavior, not the handler.
    await withTarget(async (empty) => {
      const prepared = await planComposition(inputForEffect(empty));
      assert.equal(prepared.plan, undefined);
      assert.ok(
        prepared.conflicts.some((conflict) => conflict.includes("requires package.json")),
        prepared.conflicts.join("\n"),
      );
    });

    // Version drift blocks loudly with Effect-style wording.
    await withTarget(async (target) => {
      await writeFile(
        join(target, "package.json"),
        JSON.stringify({ dependencies: { "generated-lib": "9.9.9" } }),
      );
      const prepared = await planComposition(inputForEffect(target));
      assert.equal(prepared.plan, undefined);
      assert.ok(
        prepared.conflicts.some((conflict) => conflict.includes("expected 1.0.0, found 9.9.9")),
        prepared.conflicts.join("\n"),
      );
    });

    // Satisfied environment plans the gated command, then settles.
    await withTarget(async (target) => {
      await writeFile(
        join(target, "package.json"),
        JSON.stringify({ dependencies: { "generated-lib": "1.0.0" } }),
      );
      const first = await planComposition(inputForEffect(target));
      assert.deepEqual(first.conflicts, [], first.conflicts.join("\n"));
      assert.deepEqual(
        first.plan!.operations.map((operation) => operation.kind),
        ["write", "command"],
      );
      const applied = await executePlan(first.plan!);
      assert.equal(applied.status, "applied");
      assert.deepEqual(await verifyComposition(inputForEffect(target)), []);
      const settled = await planComposition(inputForEffect(target));
      assert.deepEqual(settled.conflicts, []);
      assert.deepEqual(settled.plan!.operations, []);
    });
  });
});

test("invalid selected behavior modules fail loudly while loading stays quiet", async () => {
  await withHome(async (home) => {
    const cases: [string, string, RegExp][] = [
      ["gx-syntax", "export default {oops", /failed to load/],
      ["gx-no-default", "export const x = 1;", /must default-export a behavior object/],
      ["gx-non-object", "export default 42;", /must default-export a behavior object/],
      [
        "gx-unknown-key",
        "export default { prepare: async () => ({ conflicts: [], evidence: [], operations: [] }), bogus: 1 };",
        /unknown key\(s\): bogus/,
      ],
      ["gx-non-callable", 'export default { finalize: "yes" };', /hook 'finalize' is not callable/],
      ["gx-no-hooks", "export default {};", /exports no hooks/],
    ];
    for (const [name, source] of cases)
      await writeRecipe(home, name, { behaviorMjs: `${source}\n` });
    // Detection is metadata-only: every invalid module still loads.
    const loaded = await loadAllRecipes(home);
    assert.deepEqual(loaded.conflicts, []);
    for (const [name, , pattern] of cases) {
      const prepared = await planComposition({
        cwd: join(home, "unused-target"),
        recipes: loaded.recipes,
        entry: name,
        invocation: [],
        handlers,
        read,
      });
      assert.equal(prepared.plan, undefined, name);
      assert.ok(
        prepared.conflicts.some(
          (conflict) => conflict.includes(`Recipe '${name}'`) && pattern.test(conflict),
        ),
        `${name}: ${prepared.conflicts.join("\n")}`,
      );
    }
  });
});

test("broken unrelated behavior does not poison another recipe", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "broken", { behaviorMjs: "export default {oops\n" });
    await writeRecipe(home, "ok", {
      artifacts: { "package.json": JSON.stringify({ dependencies: { "ok-lib": "1.0.0" } }) },
    });
    const loaded = await loadAllRecipes(home);
    assert.deepEqual(loaded.conflicts, []);
    await withTarget(async (target) => {
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const prepared = await planComposition({
        cwd: target,
        recipes: loaded.recipes,
        entry: "ok",
        invocation: [],
        handlers,
        read,
      });
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      assert.ok(prepared.plan!.operations.length > 0);
    });
    // The broken module is genuinely broken: selecting it fails loudly.
    const selected = await planComposition({
      cwd: join(home, "unused-target"),
      recipes: loaded.recipes,
      entry: "broken",
      invocation: [],
      handlers,
      read,
    });
    assert.equal(selected.plan, undefined);
    assert.ok(
      selected.conflicts.some((conflict) => conflict.includes("failed to load")),
      selected.conflicts.join("\n"),
    );
  });
});

test("pack output carries no inferred behavior module", async () => {
  await withHome(async (home) => {
    await withTarget(async (project) => {
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({
          name: "source",
          private: true,
          type: "module",
          packageManager: "pnpm@10.11.0",
          dependencies: { effect: "4.0.0-rc.112" },
        }),
      );
      const packed = await packRecipe(project, "packed", [], []);
      assert.ok(packed.recipe);
      await saveRecipe(home, packed.recipe.name, packed.recipe.artifacts);
      const top = (await readdir(join(home, "recipes", "packed"))).sort();
      assert.deepEqual(top, ["artifacts", "recipe.json"]);
    });
  });
});

test("create runs durable finalize behavior through the same Core path", async () => {
  await withHome(async (home) => {
    await withTarget(async (workspace) => {
      // Create plans against an empty target, so a create-suitable
      // finalize cannot precondition on target state that only exists
      // after its own artifacts materialize; it gates on its marker.
      // Same recipe name as the composition fixture is safe: every test
      // owns an isolated home, so each behavior URL is distinct.
      await writeRecipe(home, "fx-effect", {
        behaviorMjs: `\
const node = ${nodeBin};
const MARKER = "fx-effect.done";
const markerScript = ${markerScript};
export default {
  finalize: async (context) => {
    if ((await context.read(MARKER)) !== null)
      return { conflicts: [], evidence: ["fx-effect already recorded"], operations: [] };
    return {
      conflicts: [],
      evidence: [],
      operations: [
        {
          kind: "command",
          executable: node,
          args: ["-e", markerScript],
          cwd: context.cwd,
          purpose: "Record fx-effect application",
        },
      ],
    };
  },
  verify: async (context) => {
    if (context.instance[context.instance.length - 1] !== "fx-effect")
      return ["fx-effect verifier saw foreign instance " + context.instance.join(" > ")];
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      await readFile(join(context.cwd, MARKER), "utf8");
    } catch {
      return ["fx-effect marker missing: finalize command did not run"];    }
    return [];
  },
};
`,
        artifacts: { "package.json": JSON.stringify({ dependencies: {}, devDependencies: {} }) },
      });
      const prepared = await planCreate(home, workspace, "new-app", "fx-effect");
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      // Writes execute before the finalize command; the trailing pnpm
      // install is create's disclosed step, not behavior ordering.
      const kinds = prepared.plan!.operations.map((operation) => operation.kind);
      assert.equal(kinds[0], "write");
      assert.ok(kinds.includes("command"));
      const applied = await executePlan(prepared.plan!);
      assert.equal(applied.status, "applied", JSON.stringify(applied.errors));
      assert.deepEqual(await verifyCreate(prepared.input!, prepared.target), []);
      assert.equal(
        await readFile(join(prepared.target, "fx-effect.done"), "utf8").catch(() => null),
        "done\n",
      );
      // SAFETY: create materializes package.json with the target name by construction.
      const manifest = JSON.parse(
        await readFile(join(prepared.target, "package.json"), "utf8"),
      ) as {
        name: string;
      };
      assert.equal(manifest.name, "new-app");
    });
  });
});

test("tamo add runs a durable prepare composition end to end", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      await writeComposition(home);
      const added = runCli(["add", "fx-web", "--cwd", target, "--json", "--yes"], home);
      assert.equal(added.code, 0, added.stderr);
      // SAFETY: the merged manifest carries dependency maps by handler construction.
      const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      assert.deepEqual(manifest.dependencies, {
        "generated-lib": "1.0.0",
        "fx-init-lib": "1.0.0",
        "fx-effect-lib": "2.0.0",
        "sibling-lib": "3.0.0",
      });
      assert.equal(
        await readFile(join(target, "fx-effect.done"), "utf8").catch(() => null),
        "done\n",
      );
    });
  });
});

test("real Effect behavior runs through durable behavior.mjs", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      // The installed recipe is a copy of the canonical durable recipe:
      // recipe.json + self-contained behavior.mjs + artifacts. No checkout
      // file URL participates, and every name is ordinary.
      await seedEffectRecipe(home, "real-effect");
      // Real-FS target mirroring the effect-oxlint fixture: declared
      // preconditions plus installed markers so planning reaches commands.
      await writeFile(
        join(target, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@10.11.0",
          dependencies: { effect: versions.effect },
          devDependencies: { oxlint: versions.oxlint },
          scripts: { prepare: "node setup.mjs" },
        }),
      );
      await writeFile(join(target, ".oxlintrc.jsonc"), '{"rules":{}}\n');
      for (const name of ["effect", "oxlint"]) {
        await mkdir(join(target, "node_modules", name), { recursive: true });
        await writeFile(
          join(target, "node_modules", name, "package.json"),
          JSON.stringify({ version: versions[name] }),
        );
      }
      const loaded = await loadAllRecipes(home);
      assert.deepEqual(loaded.conflicts, []);
      const durable = await planComposition({
        cwd: target,
        recipes: loaded.recipes,
        entry: "real-effect",
        invocation: [],
        handlers,
        read,
      });
      assert.deepEqual(durable.conflicts, [], durable.conflicts.join("\n"));
      // Prerequisite/version checks, tracked inputs, and finalize
      // install/patch commands plan through the durable path.
      const kinds = durable.plan!.operations.map((operation) => operation.kind);
      assert.ok(kinds.includes("write"), JSON.stringify(kinds));
      assert.deepEqual(
        durable
          .plan!.operations.filter((operation) => operation.kind === "command")
          .map((operation) => (operation.kind === "command" ? operation.args : [])),
        [
          ["install", "--ignore-scripts"],
          ["exec", "effect-tsgo", "patch", "--no-typescript", "--oxlint"],
        ],
      );
      // The behavior file itself is a reviewed input of the durable plan.
      assert.ok(
        durable.plan!.inputs.some((input) => input.path.endsWith("behavior.mjs")),
        JSON.stringify(durable.plan!.inputs.map((input) => input.path)),
      );
    });
  });
});

test("finalize hooks evaluate before same-Plan writes exist on disk", async () => {
  await withTarget(async (target) => {
    let observed: string | null | undefined;
    const recipes: Record<string, Recipe> = {
      web: {
        name: "web",
        artifacts: [{ path: "package.json", contents: '{"dependencies":{"w-lib":"1.0.0"}}' }],
        behavior: {
          finalize: async (context) => {
            // The Plan's own write has not executed: the target is still empty.
            observed = await context.read("package.json");
            if ((await context.read("w.done")) !== null)
              return { conflicts: [], evidence: [], operations: [] };
            return {
              conflicts: [],
              evidence: [],
              operations: [
                {
                  kind: "command",
                  executable: process.execPath,
                  args: ["-e", 'require("node:fs").writeFileSync("w.done","done\\n")'],
                  cwd: context.cwd,
                  purpose: "post-write check",
                },
              ],
            };
          },
          verify: async () => [],
        },
      },
    };
    const prepared = await planComposition({
      cwd: target,
      recipes,
      entry: "web",
      invocation: [],
      handlers,
      read,
    });
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    assert.equal(observed, null);
    // Operations EXECUTE writes first even though planning saw no file.
    assert.deepEqual(
      prepared.plan!.operations.map((operation) => operation.kind),
      ["write", "command"],
    );
    const applied = await executePlan(prepared.plan!);
    assert.equal(applied.status, "applied", JSON.stringify(applied.errors));
    assert.deepEqual(
      await verifyComposition({
        cwd: target,
        recipes,
        entry: "web",
        invocation: [],
        handlers,
        read,
      }),
      [],
    );
  });
});

test("create plans a preparation stage instead of blocking", async () => {
  await withHome(async (home) => {
    await withTarget(async (workspace) => {
      await writeRecipe(home, "fx-prep", {
        behaviorMjs: fxInitBehavior(),
        artifacts: { "package.json": fxInitManifest },
      });
      // Stage 1 is the initializer command only; the fresh stage-2 pass
      // after execution plans the final create through the same path.
      const first = await planCreate(home, workspace, "new-app", "fx-prep");
      assert.deepEqual(first.conflicts, [], first.conflicts.join("\n"));
      assert.equal(first.plan!.requiresReplan, true);
      assert.deepEqual(
        first.plan!.operations.map((operation) => operation.kind),
        ["command"],
      );
      const applied = await executePlan(first.plan!);
      assert.equal(applied.status, "applied", JSON.stringify(applied.errors));
      const second = await planCreate(home, workspace, "new-app", "fx-prep", {
        allowPopulatedTarget: true,
      });
      assert.deepEqual(second.conflicts, [], second.conflicts.join("\n"));
      assert.equal(second.plan!.requiresReplan, false);
      assert.ok(second.plan!.operations.some((operation) => operation.kind === "write"));
    });
  });
});

test("mutating behavior.mjs after planning rejects execution", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      await writeRecipe(home, "fx-watched", {
        behaviorMjs: "export default { verify: async () => [] };\n",
        artifacts: { "package.json": JSON.stringify({ dependencies: { "w-lib": "1.0.0" } }) },
      });
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const loaded = await loadAllRecipes(home);
      assert.deepEqual(loaded.conflicts, []);
      const prepared = await planComposition({
        cwd: target,
        recipes: loaded.recipes,
        entry: "fx-watched",
        invocation: [],
        handlers,
        read,
      });
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      assert.ok(prepared.plan!.operations.length > 0);
      const before = await readFile(join(target, "package.json"), "utf8");
      await writeFile(
        join(home, "recipes", "fx-watched", "behavior.mjs"),
        "export default { verify: async () => [] };\n// edited after review\n",
      );
      const result = await executePlan(prepared.plan!);
      assert.equal(result.status, "failed");
      assert.equal(result.completed.length, 0);
      assert.ok(
        result.errors.some((error) => error.includes("Input changed")),
        result.errors.join("\n"),
      );
      assert.equal(await readFile(join(target, "package.json"), "utf8"), before);
    });
  });
});

test("no recipe-name special cases exist in loading or binding", async () => {
  const sources = await Promise.all(
    ["src/compose.ts", "src/recipes.ts"].map((file) => readFile(join(root, file), "utf8")),
  );
  // The fx-/gx- prefixes are unique to fixtures. Plain words like sibling
  // also appear as ordinary prose in Core comments, so only the prefixes
  // are asserted here.
  for (const source of sources)
    for (const name of ["fx-init", "fx-effect", "fx-web", "gx-"])
      assert.equal(source.includes(name), false, `special case for ${name}`);
});
