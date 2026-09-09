import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planComposition, verifyComposition } from "../src/compose.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { loadRecipe, loadRecipeTree } from "../src/recipes.ts";
import { executePlan, read } from "../src/runtime.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];
const nodeBin = JSON.stringify(process.execPath);

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tamo-custom-behavior-home-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function withTarget(run: (target: string) => Promise<void>): Promise<void> {
  const target = await mkdtemp(join(tmpdir(), "tamo-custom-behavior-target-"));
  try {
    await run(target);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

async function writeRecipe(
  home: string,
  name: string,
  options: {
    recipeJson?: string;
    files?: Record<string, string>;
    artifacts?: Record<string, string>;
  },
): Promise<void> {
  const dir = join(home, "recipes", name);
  await mkdir(join(dir, "artifacts"), { recursive: true });
  await writeFile(join(dir, "recipe.json"), options.recipeJson ?? "{}\n");
  for (const [path, contents] of Object.entries(options.artifacts ?? {})) {
    const absolute = join(dir, "artifacts", path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
  for (const [path, contents] of Object.entries(options.files ?? {})) {
    const absolute = join(dir, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }
}

function markerBehavior(purpose: string): string {
  const script = JSON.stringify(`require("node:fs").writeFileSync("custom.done", "done\\n")`);
  return `export default {
  finalize: async (context) => {
    if ((await context.read("custom.done")) !== null)
      return { conflicts: [], evidence: [], operations: [] };
    return {
      conflicts: [],
      evidence: [],
      operations: [
        { kind: "command", executable: ${nodeBin}, args: ["-e", ${script}], cwd: context.cwd, purpose: ${JSON.stringify(purpose)} },
      ],
    };
  },
  verify: async (context) => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    try {
      await readFile(join(context.cwd, "custom.done"), "utf8");
    } catch {
      return ["custom marker missing: finalize command did not run"];
    }
    return [];
  },
};
`;
}

const manifest = JSON.stringify({ dependencies: { "custom-lib": "1.0.0" } });

test("default behavior.mjs still loads", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "plain", {
      files: { "behavior.mjs": "export default { verify: async () => [] };\n" },
      artifacts: { "package.json": manifest },
    });
    const loaded = await loadRecipe(home, "plain");
    assert.deepEqual(loaded.conflicts, []);
    assert.ok(loaded.recipe!.behaviorFile!.endsWith(join("plain", "behavior.mjs")));
  });
});

test("custom setup.mjs loads", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "custom", {
      recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
      files: { "setup.mjs": "export default { verify: async () => [] };\n" },
      artifacts: { "package.json": manifest },
    });
    const loaded = await loadRecipe(home, "custom");
    assert.deepEqual(loaded.conflicts, [], loaded.conflicts.join("\n"));
    assert.ok(loaded.recipe!.behaviorFile!.endsWith(join("custom", "setup.mjs")));
    assert.ok(
      loaded.snapshots.some((snapshot) => snapshot.path.endsWith(join("custom", "setup.mjs"))),
    );
  });
});

test("nested scripts/setup.mjs loads", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "nested", {
      recipeJson: JSON.stringify({ behavior: "scripts/setup.mjs" }),
      files: { "scripts/setup.mjs": "export default { verify: async () => [] };\n" },
      artifacts: { "package.json": manifest },
    });
    const loaded = await loadRecipe(home, "nested");
    assert.deepEqual(loaded.conflicts, [], loaded.conflicts.join("\n"));
    assert.ok(loaded.recipe!.behaviorFile!.endsWith(join("nested", "scripts", "setup.mjs")));
  });
});

test("explicit configuration wins over default behavior.mjs", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      await writeRecipe(home, "both", {
        recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
        files: {
          "behavior.mjs": markerBehavior("default should not run"),
          "setup.mjs": markerBehavior("custom runs"),
        },
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipe(home, "both");
      assert.deepEqual(loaded.conflicts, []);
      assert.ok(loaded.recipe!.behaviorFile!.endsWith(join("both", "setup.mjs")));
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const prepared = await planComposition({
        cwd: target,
        recipes: { both: loaded.recipe! },
        entry: "both",
        invocation: [],
        handlers,
        read,
      });
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      const command = prepared.plan!.operations.find((operation) => operation.kind === "command");
      assert.ok(command && command.kind === "command" && command.purpose === "custom runs");
    });
  });
});

test("explicit missing Behavior fails clearly", async () => {
  await withHome(async (home) => {
    await writeRecipe(home, "missing", {
      recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
      artifacts: { "package.json": manifest },
    });
    const loaded = await loadRecipe(home, "missing");
    assert.ok(
      loaded.conflicts.some((conflict) => conflict.includes("not found")),
      loaded.conflicts.join("\n"),
    );
  });
});

test("unsupported Behavior extensions are rejected", async () => {
  await withHome(async (home) => {
    for (const value of ["setup.js", "setup.ts", "setup.cjs", "setup.mjs.txt"]) {
      await writeRecipe(home, "bad-ext", {
        recipeJson: JSON.stringify({ behavior: value }),
        files: { [value]: "export default { verify: async () => [] };\n" },
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipe(home, "bad-ext");
      assert.ok(
        loaded.conflicts.some((conflict) => conflict.includes(".mjs")),
        `${value}: ${loaded.conflicts.join("\n")}`,
      );
    }
  });
});

test("absolute Behavior paths are rejected", async () => {
  await withHome(async (home) => {
    for (const value of ["/setup.mjs", "/scripts/setup.mjs"]) {
      await writeRecipe(home, "absolute", {
        recipeJson: JSON.stringify({ behavior: value }),
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipe(home, "absolute");
      assert.ok(
        loaded.conflicts.some((conflict) => conflict.includes("relative")),
        `${value}: ${loaded.conflicts.join("\n")}`,
      );
    }
  });
});

test("Behavior paths escaping the recipe root are rejected", async () => {
  await withHome(async (home) => {
    for (const value of ["../outside.mjs", "scripts/../../outside.mjs", "..\\outside.mjs"]) {
      await writeRecipe(home, "escape", {
        recipeJson: JSON.stringify({ behavior: value }),
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipe(home, "escape");
      assert.ok(
        loaded.conflicts.some((conflict) => conflict.includes("inside the recipe")),
        `${value}: ${loaded.conflicts.join("\n")}`,
      );
    }
  });
});

test("malformed and non-string Behavior values are rejected", async () => {
  await withHome(async (home) => {
    const cases: [string, string][] = [
      ["non-string-number", `{"behavior":42}`],
      ["non-string-null", `{"behavior":null}`],
      ["non-string-array", `{"behavior":["setup.mjs"]}`],
      ["non-string-object", `{"behavior":{"path":"setup.mjs"}}`],
      ["empty-string", `{"behavior":""}`],
    ];
    for (const [name, recipeJson] of cases) {
      await writeRecipe(home, name, {
        recipeJson: `${recipeJson}\n`,
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipe(home, name);
      assert.ok(
        loaded.conflicts.some((conflict) => conflict.includes("behavior")),
        `${name}: ${loaded.conflicts.join("\n")}`,
      );
    }
  });
});

test("symlinked custom Behavior is rejected", async () => {
  if (process.platform === "win32") return;
  await withHome(async (home) => {
    const { symlink } = await import("node:fs/promises");
    await writeRecipe(home, "linked", {
      recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
      files: { "real.mjs": "export default { verify: async () => [] };\n" },
      artifacts: { "package.json": manifest },
    });
    await symlink(
      join(home, "recipes", "linked", "real.mjs"),
      join(home, "recipes", "linked", "setup.mjs"),
    );
    const loaded = await loadRecipe(home, "linked");
    assert.ok(
      loaded.conflicts.some((conflict) => conflict.includes("symlink")),
      loaded.conflicts.join("\n"),
    );
  });
});

test("custom prepare works", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      const initializer = JSON.stringify(
        `require("node:fs").writeFileSync(${JSON.stringify(join(target, "package.json"))}, '{"dependencies":{"gen-lib":"1.0.0"}}')`,
      );
      await writeRecipe(home, "prep", {
        recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
        files: {
          "setup.mjs": `export default {
  prepare: async (context) => {
    if ((await context.read("package.json")) !== null)
      return { conflicts: [], evidence: ["output present"], operations: [] };
    return {
      conflicts: [],
      evidence: ["plans the initializer"],
      operations: [
        { kind: "command", executable: ${nodeBin}, args: ["-e", ${initializer}], cwd: context.cwd, purpose: "Generate fixture state" },
      ],
    };
  },
  verify: async () => [],
};
`,
        },
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipeTree(home, "prep");
      assert.deepEqual(loaded.conflicts, [], loaded.conflicts.join("\n"));
      const prepared = await planComposition({
        cwd: target,
        recipes: loaded.recipes,
        entry: "prep",
        invocation: [],
        handlers,
        read,
      });
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      assert.equal(prepared.plan!.requiresReplan, true);
      assert.deepEqual(
        prepared.plan!.operations.map((operation) => operation.kind),
        ["command"],
      );
    });
  });
});

test("custom finalize and verify work end to end", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      await writeRecipe(home, "fx", {
        recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
        files: { "setup.mjs": markerBehavior("custom finalize") },
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipeTree(home, "fx");
      assert.deepEqual(loaded.conflicts, [], loaded.conflicts.join("\n"));
      const input = {
        cwd: target,
        recipes: loaded.recipes,
        entry: "fx",
        invocation: [],
        handlers,
        read,
      };
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const planned = await planComposition(input);
      assert.deepEqual(planned.conflicts, [], planned.conflicts.join("\n"));
      assert.ok(
        planned.plan!.operations.some(
          (operation) => operation.kind === "command" && operation.purpose === "custom finalize",
        ),
      );
      const applied = await executePlan(planned.plan!);
      assert.equal(applied.status, "applied", JSON.stringify(applied.errors));
      assert.deepEqual(await verifyComposition(input), []);
    });
  });
});

test("selected custom Behavior mutation invalidates execution", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      await writeRecipe(home, "watched", {
        recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
        files: { "setup.mjs": "export default { verify: async () => [] };\n" },
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipeTree(home, "watched");
      assert.deepEqual(loaded.conflicts, []);
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const { planComposition: plan } = await import("../src/compose.ts");
      const prepared = await plan({
        cwd: target,
        recipes: loaded.recipes,
        entry: "watched",
        invocation: [],
        handlers,
        read,
      });
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      const before = await readFile(join(target, "package.json"), "utf8");
      await writeFile(
        join(home, "recipes", "watched", "setup.mjs"),
        "export default { verify: async () => [] };\n// edited after review\n",
      );
      const result = await executePlan(prepared.plan!);
      assert.equal(result.status, "failed");
      assert.ok(result.errors.some((error) => error.includes("Input changed")));
      assert.equal(await readFile(join(target, "package.json"), "utf8"), before);
    });
  });
});

test("unrelated custom Behavior mutation does not invalidate the selected plan", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      await writeRecipe(home, "selected", {
        artifacts: { "package.json": manifest },
      });
      await writeRecipe(home, "unrelated", {
        recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
        files: { "setup.mjs": "export default { verify: async () => [] };\n" },
        artifacts: { "package.json": JSON.stringify({ dependencies: { "other-lib": "1.0.0" } }) },
      });
      const loaded = await loadRecipeTree(home, "selected");
      assert.deepEqual(loaded.conflicts, []);
      await writeFile(join(target, "package.json"), JSON.stringify({ name: "t" }));
      const prepared = await planComposition({
        cwd: target,
        recipes: loaded.recipes,
        entry: "selected",
        invocation: [],
        handlers,
        read,
      });
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      await writeFile(
        join(home, "recipes", "unrelated", "setup.mjs"),
        "export default { verify: async () => [] };\n// unrelated edit\n",
      );
      const result = await executePlan(prepared.plan!);
      assert.equal(result.status, "applied", JSON.stringify(result.errors));
    });
  });
});

test("broken unrelated custom Behavior is ignored by demand-first loading", async () => {
  await withHome(async (home) => {
    await withTarget(async (target) => {
      await writeRecipe(home, "broken", {
        recipeJson: JSON.stringify({ behavior: "setup.mjs" }),
        files: { "setup.mjs": "export default {oops\n" },
      });
      await writeRecipe(home, "ok", {
        artifacts: { "package.json": manifest },
      });
      const loaded = await loadRecipeTree(home, "ok");
      assert.deepEqual(loaded.conflicts, [], loaded.conflicts.join("\n"));
      assert.deepEqual(Object.keys(loaded.recipes), ["ok"]);
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
      const selected = await loadRecipeTree(home, "broken");
      assert.deepEqual(selected.conflicts, []);
      const broken = await planComposition({
        cwd: target,
        recipes: selected.recipes,
        entry: "broken",
        invocation: [],
        handlers,
        read,
      });
      assert.equal(broken.plan, undefined);
      assert.ok(
        broken.conflicts.some((conflict) => conflict.includes("failed to load")),
        broken.conflicts.join("\n"),
      );
    });
  });
});
