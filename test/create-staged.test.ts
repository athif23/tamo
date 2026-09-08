import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyRecipeWithReplan, planComposition } from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { loadAllRecipes } from "../src/recipes.ts";
import { entryType, executePlan, read } from "../src/runtime.ts";
import { planCreate, verifyCreate } from "../src/create.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];
const root = resolve(".");
const nodeBin = JSON.stringify(process.execPath);
const initScript = JSON.stringify(join(root, "test", "fixtures", "init-scaffold.mjs"));

// Parent web over an initializer child (prepare + package contribution), a
// finalize child (finalize + verify + package contribution), and one
// artifact-only sibling (package contribution + config contribution). Every
// behavior attaches through its own behavior.mjs; no recipe name carries
// meaning to Core.
const INIT_MANIFEST = JSON.stringify({ scripts: { "setup:init": "node init-task.js" } });
const FINAL_MANIFEST = JSON.stringify({ scripts: { "check:final": "node final-check.js" } });
const SIBLING_MANIFEST = JSON.stringify({ scripts: { "lint:sibling": "node sibling-lint.js" } });
const SIBLING_CONFIG = JSON.stringify({ rules: { "sibling-rule": "error" } });
const FINAL_MARKER = "cx-final.done";

async function withHomeAndWorkspace(run: (home: string, workspace: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "tamo-cx-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "tamo-cx-ws-"));
  try {
    await run(home, workspace);
  } finally {
    await rm(home, { recursive: true, force: true });
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

function runCli(args: string[], home: string) {
  const result = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, TAMO_HOME: home },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// The initializer child: state-gated on the target manifest, scaffolds the
// absent target from its existing parent workspace, then settles. The
// command cwd is the workspace — never the not-yet-existing target.
function cxInitBehaviorJs(fail = false): string {
  return `\
import { dirname, basename, join } from "node:path";
const node = ${nodeBin};
const initializer = ${initScript};
export default {
  prepare: async (context) => {
    if ((await context.read("package.json")) !== null)
      return { conflicts: [], evidence: ["cx-init output present"], operations: [] };
    const workspace = dirname(context.cwd);
    const target = join(workspace, basename(context.cwd));
    return {
      conflicts: [],
      evidence: ["cx-init scaffolds the target first"],
      operations: [
        {
          kind: "command",
          executable: node,
          args: ${fail ? `[initializer, target, "--fail"]` : `[initializer, target, "--bare"]`},
          cwd: workspace,
          purpose: "Scaffold the create target with the initializer fixture",
        },
      ],
    };
  },
  verify: async (context) => {
    const tail = context.instance[context.instance.length - 1];
    if (tail !== "cx-init")
      return ["cx-init verifier saw foreign instance " + context.instance.join(" > ")];
    const { appendFile, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const paths = context.artifacts.map((artifact) => artifact.path).sort().join(",");
    await appendFile(
      join(context.cwd, "verify.log"),
      context.instance.join(" > ") + " :: " + paths + "\\n",
    );
    try {
      await readFile(join(context.cwd, "package.json"), "utf8");
    } catch {
      return ["cx-init target package.json missing: initializer did not run"];
    }
    return [];
  },
};
`;
}

// The finalize child: gates only on its own marker, never on target state
// that same-Plan writes have yet to create. The failing variant always
// produces a non-zero command for partial-application tests.
function cxFinalBehaviorJs(mode: "ok" | "fail" = "ok"): string {
  const command =
    mode === "ok"
      ? `{ kind: "command", executable: node, args: ["-e", markerScript], cwd: context.cwd, purpose: "Record cx-final application" }`
      : `{ kind: "command", executable: node, args: ["-e", "process.exit(3)"], cwd: context.cwd, purpose: "Failing final check" }`;
  return `\
const node = ${nodeBin};
const MARKER = ${JSON.stringify(FINAL_MARKER)};
const markerScript = ${JSON.stringify(`require("node:fs").writeFileSync("${FINAL_MARKER}", "done\\n")`)};
export default {
  finalize: async (context) => {
    if ((await context.read(MARKER)) !== null)
      return { conflicts: [], evidence: ["cx-final already recorded"], operations: [] };
    return { conflicts: [], evidence: [], operations: [${command}] };
  },
  verify: async (context) => {
    const tail = context.instance[context.instance.length - 1];
    if (tail !== "cx-final")
      return ["cx-final verifier saw foreign instance " + context.instance.join(" > ")];
    const { appendFile, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const paths = context.artifacts.map((artifact) => artifact.path).sort().join(",");
    await appendFile(
      join(context.cwd, "verify.log"),
      context.instance.join(" > ") + " :: " + paths + "\\n",
    );
    try {
      await readFile(join(context.cwd, MARKER), "utf8");
    } catch {
      return ["cx-final marker missing: finalize command did not run"];
    }
    return [];
  },
};
`;
}

async function writeStandardComposition(
  home: string,
  options: { initFail?: boolean; finalMode?: "ok" | "fail"; siblingManifest?: string } = {},
): Promise<void> {
  await writeRecipe(home, "cx-init", {
    behaviorMjs: cxInitBehaviorJs(options.initFail),
    artifacts: { "package.json": INIT_MANIFEST },
  });
  await writeRecipe(home, "cx-final", {
    behaviorMjs: cxFinalBehaviorJs(options.finalMode),
    artifacts: { "package.json": FINAL_MANIFEST },
  });
  await writeRecipe(home, "cx-extra", {
    artifacts: {
      "package.json": options.siblingManifest ?? SIBLING_MANIFEST,
      ".oxlintrc.jsonc": SIBLING_CONFIG,
    },
  });
  await writeRecipe(home, "cx-web", {
    recipeJson: JSON.stringify({
      includes: [{ recipe: "cx-init" }, { recipe: "cx-final" }, { recipe: "cx-extra" }],
    }),
  });
}

function jsonLines(stdout: string) {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test("absent target plus durable prepare plans a stage-1 command only", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeStandardComposition(home);
    const behaviorBefore = await readFile(join(home, "recipes", "cx-init", "behavior.mjs"), "utf8");
    const prepared = await planCreate(home, workspace, "my-app", "cx-web");
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    const plan = prepared.plan!;
    assert.equal(plan.requiresReplan, true);
    assert.deepEqual(
      plan.operations.map((operation) => operation.kind),
      ["command"],
    );
    assert.deepEqual(
      plan.operations.filter((operation) => operation.kind === "write"),
      [],
      "stage 1 fabricates no downstream writes",
    );
    const initializer = plan.operations[0]!;
    assert.equal(initializer.kind, "command");
    if (initializer.kind !== "command") assert.fail("expected the initializer command");
    assert.ok(initializer.args.some((arg) => arg.endsWith("init-scaffold.mjs")));
    // The command runs from the existing parent workspace, not the absent target.
    assert.equal(initializer.cwd, workspace);
    // The behavior module is a reviewed input of the preparation plan.
    assert.ok(
      plan.inputs.some((input) => input.path.endsWith(join("cx-init", "behavior.mjs"))),
      JSON.stringify(plan.inputs.map((input) => input.path)),
    );
    // Planning wrote nothing anywhere.
    assert.equal(await entryType(join(workspace, "my-app")), null);
    assert.equal(
      await readFile(join(home, "recipes", "cx-init", "behavior.mjs"), "utf8"),
      behaviorBefore,
    );
  });
});

test("staged create end to end through the real CLI", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeStandardComposition(home);
    const recipeManifestBefore = await readFile(
      join(home, "recipes", "cx-init", "artifacts", "package.json"),
      "utf8",
    );
    const created = runCli(
      ["create", "my-app", "--recipe", "cx-web", "--cwd", workspace, "--json", "--yes"],
      home,
    );
    assert.equal(created.code, 0, created.stderr);
    const records = jsonLines(created.stdout);
    assert.equal(records.length, 2);

    const [first, second] = records;
    assert.equal(first.plan.requiresReplan, true);
    assert.deepEqual(
      first.plan.operations.map((operation: { kind: string }) => operation.kind),
      ["command"],
    );
    assert.equal(first.result.status, "applied");
    assert.equal(second.plan.requiresReplan, false);
    const kinds = second.plan.operations.map((operation: { kind: string }) => operation.kind);
    assert.deepEqual(kinds, ["write", "write", "command", "command"]);
    const purposes = second.plan.operations
      .filter((operation: { kind: string }) => operation.kind === "command")
      .map((operation: { purpose: string }) => operation.purpose);
    assert.deepEqual(purposes, [
      "Record cx-final application",
      "Install the recipe's dependencies and update the lockfile (lifecycle scripts enabled)",
    ]);
    assert.equal(second.result.status, "applied");

    const target = join(workspace, "my-app");
    // SAFETY: the merged manifest carries dependency/script maps by handler construction.
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      name: string;
      scripts: Record<string, string>;
    };
    assert.deepEqual(manifest, {
      name: "my-app",
      scripts: {
        start: "node index.js",
        "setup:init": "node init-task.js",
        "check:final": "node final-check.js",
        "lint:sibling": "node sibling-lint.js",
      },
    });
    // SAFETY: the merged config carries a rules map by handler construction.
    const config = JSON.parse(await readFile(join(target, ".oxlintrc.jsonc"), "utf8")) as {
      rules: Record<string, string>;
    };
    assert.deepEqual(config.rules, { "generated-rule": "warn", "sibling-rule": "error" });
    assert.equal(await readFile(join(target, "index.js"), "utf8"), 'console.log("scaffold");\n');
    assert.equal(await readFile(join(target, FINAL_MARKER), "utf8"), "done\n");
    assert.notEqual(await readdir(join(target, "node_modules")).catch(() => null), null);
    // Both verifiers ran with their own instance identity and artifacts.
    const log = await readFile(join(target, "verify.log"), "utf8");
    assert.ok(log.includes("cx-web > cx-init :: package.json"), log);
    assert.ok(log.includes("cx-web > cx-final :: package.json"), log);
    // Create stamping did not mutate the durable recipe.
    assert.equal(
      await readFile(join(home, "recipes", "cx-init", "artifacts", "package.json"), "utf8"),
      recipeManifestBefore,
    );
    assert.ok(!("name" in JSON.parse(recipeManifestBefore)));

    // A settled replan proposes nothing.
    const fresh = await loadAllRecipes(home);
    assert.deepEqual(fresh.conflicts, []);
    const settled = await planComposition({
      cwd: target,
      recipes: fresh.recipes,
      entry: "cx-web",
      invocation: [],
      handlers,
      read,
    });
    assert.deepEqual(settled.conflicts, [], settled.conflicts.join("\n"));
    assert.deepEqual(settled.plan!.operations, []);
    assert.equal(settled.plan!.requiresReplan, false);
  });
});

test("initial non-empty target blocks before prepare", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeStandardComposition(home);
    const target = join(workspace, "my-app");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "user-file.txt"), "precious");
    const blocked = await planCreate(home, workspace, "my-app", "cx-web");
    assert.equal(blocked.plan, undefined);
    assert.ok(
      blocked.conflicts.some((conflict) => conflict.includes("not empty")),
      blocked.conflicts.join("\n"),
    );
    assert.equal(await readFile(join(target, "user-file.txt"), "utf8"), "precious");
  });
});

test("a failed initializer stops before any replan", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeStandardComposition(home, { initFail: true });
    const target = join(workspace, "my-app");
    let plans = 0;
    const outcome = await applyRecipeWithReplan({
      planFresh: async () => {
        plans++;
        return planCreate(home, workspace, "my-app", "cx-web", {
          allowPopulatedTarget: plans > 1,
        });
      },
      review: async () => true,
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyCreate(input, target),
    });
    assert.equal(outcome.status, "failed");
    assert.equal(plans, 1);
    assert.equal(await entryType(target), null);
  });
});

test("a stage-2 handler conflict preserves generated state with zero stage-2 operations", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeStandardComposition(home, {
      siblingManifest: JSON.stringify({ scripts: { start: "node other.js" } }),
    });
    const target = join(workspace, "my-app");
    let plans = 0;
    const outcome = await applyRecipeWithReplan({
      planFresh: async () => {
        plans++;
        return planCreate(home, workspace, "my-app", "cx-web", {
          allowPopulatedTarget: plans > 1,
        });
      },
      review: async () => true,
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyCreate(input, target),
    });
    assert.equal(outcome.status, "blocked");
    assert.equal(plans, 2);
    if (outcome.status !== "blocked") assert.fail("expected a blocked outcome");
    assert.ok(
      outcome.conflicts.some((conflict) => conflict.includes("scripts.start")),
      outcome.conflicts.join("\n"),
    );
    // The successfully generated first stage is left in place, unmodified.
    // SAFETY: the generated manifest carries a scripts map by fixture construction.
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.deepEqual(manifest.scripts, { start: "node index.js" });
  });
});

test("a second preparation checkpoint blocks instead of looping", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeRecipe(home, "cx-init", {
      behaviorMjs: cxInitBehaviorJs(),
      artifacts: { "package.json": INIT_MANIFEST },
    });
    await writeRecipe(home, "cx-late", {
      behaviorMjs: `\
export default {
  prepare: async (context) => {
    // Silent while the target is absent, commanding once generated state
    // exists — a second checkpoint the bounded model must refuse to order.
    if ((await context.read("package.json")) === null)
      return { conflicts: [], evidence: ["cx-late waits"], operations: [] };
    return {
      conflicts: [],
      evidence: [],
      operations: [
        {
          kind: "command",
          executable: ${nodeBin},
          args: ["--version"],
          cwd: context.cwd,
          purpose: "Late second checkpoint",
        },
      ],
    };
  },
};
`,
      artifacts: { "package.json": FINAL_MANIFEST },
    });
    await writeRecipe(home, "cx-web", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "cx-init" }, { recipe: "cx-late" }] }),
    });
    const target = join(workspace, "my-app");
    let plans = 0;
    const outcome = await applyRecipeWithReplan({
      planFresh: async () => {
        plans++;
        return planCreate(home, workspace, "my-app", "cx-web", {
          allowPopulatedTarget: plans > 1,
        });
      },
      review: async () => true,
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyCreate(input, target),
    });
    assert.equal(outcome.status, "blocked");
    assert.equal(plans, 2);
    if (outcome.status !== "blocked") assert.fail("expected a blocked outcome");
    assert.ok(
      outcome.conflicts.some((conflict) => conflict.includes("did not settle")),
      outcome.conflicts.join("\n"),
    );
    assert.notEqual(await entryType(target), null);
  });
});

test("a failing finalize keeps artifact writes without rollback", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeStandardComposition(home, { finalMode: "fail" });
    const target = join(workspace, "my-app");
    const outcome = await applyRecipeWithReplan({
      planFresh: (() => {
        let plans = 0;
        return async () => {
          plans++;
          return planCreate(home, workspace, "my-app", "cx-web", {
            allowPopulatedTarget: plans > 1,
          });
        };
      })(),
      review: async () => true,
      execute: (plan) => executePlan(plan),
      verify: (input) => verifyCreate(input, target),
    });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") assert.fail("expected a failed outcome");
    assert.ok(
      outcome.result.errors.some((error) => error.includes("failed (3)")),
      outcome.result.errors.join("\n"),
    );
    assert.deepEqual(
      outcome.result.completed.map((operation) => operation.kind),
      ["write", "write"],
    );
    assert.deepEqual(
      outcome.result.remaining.map((operation) =>
        operation.kind === "command" ? operation.purpose : operation.kind,
      ),
      [
        "Failing final check",
        "Install the recipe's dependencies and update the lockfile (lifecycle scripts enabled)",
      ],
    );
    // SAFETY: the merged manifest carries a scripts map by handler construction.
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.equal(manifest.scripts["check:final"], "node final-check.js");
    assert.equal(await entryType(join(target, FINAL_MARKER)), null);
  });
});

test("create dry-run executes nothing and fabricates no stage 2", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeStandardComposition(home);
    const behaviorBefore = await readFile(join(home, "recipes", "cx-init", "behavior.mjs"), "utf8");
    const dry = runCli(
      ["create", "my-app", "--recipe", "cx-web", "--cwd", workspace, "--json", "--dry-run"],
      home,
    );
    assert.equal(dry.code, 0, dry.stderr);
    const result = JSON.parse(dry.stdout);
    assert.equal(result.status, "dry-run");
    assert.equal(result.plan.requiresReplan, true);
    assert.deepEqual(
      result.plan.operations.map((operation: { kind: string }) => operation.kind),
      ["command"],
    );
    assert.equal(await entryType(join(workspace, "my-app")), null);
    assert.equal(await readdir(workspace).then((entries) => entries.length), 0);
    assert.equal(
      await readFile(join(home, "recipes", "cx-init", "behavior.mjs"), "utf8"),
      behaviorBefore,
    );

    const human = runCli(
      ["create", "my-app", "--recipe", "cx-web", "--cwd", workspace, "--dry-run"],
      home,
    );
    assert.equal(human.code, 0, human.stderr);
    assert.ok(human.stdout.includes("Requires replan"), human.stdout);
    assert.equal(await entryType(join(workspace, "my-app")), null);
  });
});

test("mutating behavior.mjs after create planning rejects execution", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    await writeStandardComposition(home);
    const prepared = await planCreate(home, workspace, "my-app", "cx-web");
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    assert.ok(prepared.plan!.operations.length > 0);
    await writeFile(
      join(home, "recipes", "cx-init", "behavior.mjs"),
      `${cxInitBehaviorJs()}\n// edited after review\n`,
    );
    const result = await executePlan(prepared.plan!);
    assert.equal(result.status, "failed");
    assert.equal(result.completed.length, 0);
    assert.ok(
      result.errors.some((error) => error.includes("Input changed")),
      result.errors.join("\n"),
    );
    assert.equal(await entryType(join(workspace, "my-app")), null);
  });
});

test("a missing rename write is synthesized when nothing else touches the manifest", async () => {
  await withHomeAndWorkspace(async (home, workspace) => {
    // No recipe contributes package.json, so handlers plan no manifest
    // write; the generated name must still follow the target.
    await writeRecipe(home, "cfg-only", {
      artifacts: { ".oxlintrc.jsonc": SIBLING_CONFIG },
    });
    await writeRecipe(home, "cfg-web", {
      recipeJson: JSON.stringify({ includes: [{ recipe: "cfg-only" }] }),
    });
    const target = join(workspace, "app");
    await mkdir(target, { recursive: true });
    await writeFile(
      join(target, "package.json"),
      JSON.stringify({ name: "generated", scripts: {} }),
    );
    const blocked = await planCreate(home, workspace, "app", "cfg-web");
    assert.equal(blocked.plan, undefined);
    assert.ok(
      blocked.conflicts.some((conflict) => conflict.includes("not empty")),
      blocked.conflicts.join("\n"),
    );
    const prepared = await planCreate(home, workspace, "app", "cfg-web", {
      allowPopulatedTarget: true,
    });
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    const rename = prepared.plan!.operations.find(
      (operation) => operation.kind === "write" && operation.path.endsWith("package.json"),
    );
    if (!rename || rename.kind !== "write") assert.fail("expected a synthesized rename write");
    assert.equal(JSON.parse(rename.before!).name, "generated");
    assert.equal(JSON.parse(rename.after).name, "app");
  });
});

test("staged create composes through the same Core path without domain knowledge", async () => {
  const sources = await Promise.all(
    ["src/compose.ts", "src/create.ts"].map((file) => readFile(join(root, file), "utf8")),
  );
  for (const source of sources)
    for (const name of ["cx-init", "cx-final", "cx-extra", "cx-web", "cx-late", "my-app"])
      assert.equal(source.includes(name), false, `special case for ${name}`);
});
