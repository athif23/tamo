import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  planComposition,
  resolveRecipes,
  verifyComposition,
  type OmitEdit,
  type Recipe,
} from "../src/compose.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { executePlan, read } from "../src/runtime.ts";
import { json as jsonc } from "../src/jsonc.ts";

// The bounded experiment's recipes are plain in-memory objects, the same
// shape durable recipes load into.
const effectManifest = `{
  "name": "effect-lib",
  "version": "0.1.0",
  "packageManager": "pnpm@10.11.0",
  "scripts": {
    "prepare": "effect-tsgo patch --no-typescript --oxlint"
  },
  "dependencies": {
    "effect": "4.0.0-rc.112",
    "stripe": "^18.0.0"
  },
  "devDependencies": {
    "@effect/tsgo": "0.38.0",
    "oxlint": "1.80.0",
    "vitest": "^3.0.0"
  }
}
`;

const effectConfig = `{
  // Most rules arrive through the upstream correctness preset.
  "extends": ["./node_modules/@effect/tsgo/oxlint-presets/correctness.json"],
  "plugins": ["effecttsgo"],
  "rules": {
    // explicit personal choices
    "effecttsgo/strict-effect-provide": "error",
    "effecttsgo/leaking-requirements": "error",
    "no-null": "warn"
  }
}
`;

function baseRecipes(): Record<string, Recipe> {
  return {
    effect: {
      name: "effect",
      artifacts: [
        { path: "package.json", contents: effectManifest },
        { path: ".oxlintrc.jsonc", contents: effectConfig },
      ],
    },
    web: {
      name: "web",
      artifacts: [],
      includes: [{ recipe: "effect" }],
      customizations: [
        {
          op: "omit",
          instance: ["effect"],
          artifact: "package.json",
          selector: "dependencies",
          entry: "stripe",
        },
        {
          op: "omit",
          instance: ["effect"],
          artifact: ".oxlintrc.jsonc",
          selector: "rules",
          entry: "effecttsgo/leaking-requirements",
        },
      ],
    },
  };
}

const handlers = [packageManifestHandler, oxlintConfigHandler];

const targetManifest = `{
  "name": "fresh",
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "left-pad": "^1.3.0"
  }
}
`;

const targetConfig = `{
  // The project's own lint choices.
  "rules": {
    "no-var": "error"
  }
}
`;

async function withProject(
  run: (cwd: string) => Promise<void>,
  files: Record<string, string> = {
    "package.json": targetManifest,
    ".oxlintrc.jsonc": targetConfig,
  },
) {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-compose-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(cwd, name)), { recursive: true });
      await writeFile(join(cwd, name), contents);
    }
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function composition(cwd: string, recipes: Record<string, Recipe>, invocation: OmitEdit[] = []) {
  return planComposition({ cwd, recipes, entry: "web", invocation, handlers, read });
}

// Core-owned verification over the same input — the recipe path no longer
// manufactures or passes a behavior object.
function verify(cwd: string, recipes: Record<string, Recipe>, invocation: OmitEdit[] = []) {
  return verifyComposition({ cwd, recipes, entry: "web", invocation, handlers, read });
}

test("resolution adjusts saved artifacts in memory through both handlers", () => {
  const { artifacts, conflicts } = resolveRecipes(baseRecipes(), "web", [], handlers);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(
    artifacts.map((artifact) => artifact.path),
    ["package.json", ".oxlintrc.jsonc"],
  );
  assert.deepEqual(
    artifacts.map((artifact) => artifact.instance),
    [
      ["web", "effect"],
      ["web", "effect"],
    ],
  );

  const manifest = JSON.parse(artifacts[0]!.contents);
  assert.deepEqual(manifest.dependencies, { effect: "4.0.0-rc.112" });
  assert.ok(manifest.devDependencies["@effect/tsgo"]);
  assert.ok(artifacts[0]!.sources.some((source) => source.includes("saved:web")));

  // SAFETY: the fixture config decodes to an object whose rules map is an object.
  const rules = jsonc(artifacts[1]!.contents, "adjusted config").rules as Record<string, string>;
  assert.deepEqual(Object.keys(rules), ["effecttsgo/strict-effect-provide", "no-null"]);
  assert.ok(artifacts[1]!.sources.some((source) => source.includes("saved:web")));
});

test("saved recipes and their artifacts stay byte-for-byte unchanged", async () => {
  const recipes = baseRecipes();
  const before = JSON.stringify(recipes);
  resolveRecipes(recipes, "web", [], handlers);
  await withProject(async (cwd) => {
    await composition(cwd, recipes);
  });
  assert.equal(JSON.stringify(recipes), before);
  assert.equal(recipes.effect!.artifacts[0]!.contents, effectManifest);
  assert.equal(recipes.effect!.artifacts[1]!.contents, effectConfig);
});

test("application contributes adjusted artifacts while preserving unrelated target content", async () => {
  await withProject(async (cwd) => {
    const prepared = await composition(cwd, baseRecipes());
    assert.deepEqual(prepared.conflicts, []);
    const plan = prepared.plan!;
    assert.deepEqual(
      plan.operations.map((operation) => operation.kind),
      ["write", "write"],
    );

    const result = await executePlan(plan);
    assert.equal(result.status, "applied");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(await verify(cwd, baseRecipes()), []);

    const manifest = JSON.parse((await readFile(join(cwd, "package.json"), "utf8"))!);
    assert.equal(manifest.name, "fresh");
    assert.deepEqual(manifest.scripts, {
      build: "tsc",
      prepare: "effect-tsgo patch --no-typescript --oxlint",
    });
    assert.deepEqual(manifest.dependencies, {
      "left-pad": "^1.3.0",
      effect: "4.0.0-rc.112",
    });
    // Scalars the target lacks are set plainly; differing values would block.
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.packageManager, "pnpm@10.11.0");

    const config = (await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8"))!;
    assert.ok(config.includes("// The project's own lint choices."));
    assert.ok(config.includes('"no-var": "error"'));
    // SAFETY: the applied config decodes to an object whose rules map is an object.
    const appliedRules = jsonc(config, "applied config").rules as Record<string, string>;
    assert.equal(appliedRules["effecttsgo/strict-effect-provide"], "error");
    assert.equal(appliedRules["no-null"], "warn");
    const applied = jsonc(config, "applied config");
    assert.deepEqual(applied.extends, [
      "./node_modules/@effect/tsgo/oxlint-presets/correctness.json",
    ]);
    assert.deepEqual(applied.plugins, ["effecttsgo"]);
  });
});

test("conflicting target values block before mutation", async () => {
  const conflictingConfig = targetConfig.replace(
    '"no-var": "error"',
    '"no-var": "error",\n    "no-null": "off"',
  );
  await withProject(
    async (cwd) => {
      const prepared = await composition(cwd, baseRecipes());
      assert.equal(prepared.plan, undefined);
      assert.ok(
        prepared.conflicts.some((conflict) => conflict.includes("no-null")),
        prepared.conflicts.join("\n"),
      );
      assert.equal(await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8"), conflictingConfig);
    },
    {
      "package.json": targetManifest,
      ".oxlintrc.jsonc": conflictingConfig,
    },
  );
});

test("conflicting dependency versions block before mutation", async () => {
  const conflictingManifest = targetManifest.replace(
    '"left-pad": "^1.3.0"',
    '"left-pad": "^1.3.0",\n    "effect": "^3.0.0"',
  );
  await withProject(
    async (cwd) => {
      const prepared = await composition(cwd, baseRecipes());
      assert.equal(prepared.plan, undefined);
      assert.ok(prepared.conflicts.some((conflict) => conflict.includes("dependencies.effect")));
    },
    {
      "package.json": conflictingManifest,
      ".oxlintrc.jsonc": targetConfig,
    },
  );
});

test("stale customization references fail visibly instead of no-oping", () => {
  const staleEntry = resolveRecipes(
    baseRecipes(),
    "web",
    [
      {
        op: "omit",
        instance: ["web", "effect"],
        artifact: "package.json",
        selector: "dependencies",
        entry: "does-not-exist",
      },
    ],
    handlers,
  );
  assert.ok(staleEntry.conflicts.some((conflict) => conflict.includes("does-not-exist")));

  const unknownSelector = resolveRecipes(
    baseRecipes(),
    "web",
    [
      {
        op: "omit",
        instance: ["web", "effect"],
        artifact: "package.json",
        selector: "scripts",
        entry: "build",
      },
    ],
    handlers,
  );
  assert.ok(unknownSelector.conflicts.some((conflict) => conflict.includes("Unknown selector")));

  const unknownInstance = resolveRecipes(
    baseRecipes(),
    "web",
    [
      {
        op: "omit",
        instance: ["web", "nope"],
        artifact: "package.json",
        selector: "dependencies",
        entry: "stripe",
      },
    ],
    handlers,
  );
  assert.ok(
    unknownInstance.conflicts.some((conflict) => conflict.includes("Stale customization address")),
  );

  // Rules enabled only through the upstream correctness preset are not
  // exposed; omitting one is a stale reference, not an implicit expansion.
  const implicitRule = resolveRecipes(
    baseRecipes(),
    "web",
    [
      {
        op: "omit",
        instance: ["web", "effect"],
        artifact: ".oxlintrc.jsonc",
        selector: "rules",
        entry: "effecttsgo/floating-effect",
      },
    ],
    handlers,
  );
  assert.ok(implicitRule.conflicts.some((conflict) => conflict.includes("not present")));
});

test("identical edits through invocation and saved parent produce the same adjustment", () => {
  const savedVariant = baseRecipes();
  savedVariant.web!.customizations = [
    ...savedVariant.web!.customizations!,
    {
      op: "omit",
      instance: ["effect"],
      artifact: "package.json",
      selector: "devDependencies",
      entry: "vitest",
    },
  ];
  const viaSaved = resolveRecipes(savedVariant, "web", [], handlers);

  const viaInvocation = resolveRecipes(
    baseRecipes(),
    "web",
    [
      {
        op: "omit",
        instance: ["web", "effect"],
        artifact: "package.json",
        selector: "devDependencies",
        entry: "vitest",
      },
    ],
    handlers,
  );

  assert.deepEqual(viaSaved.conflicts, []);
  assert.deepEqual(viaInvocation.conflicts, []);
  assert.deepEqual(
    viaInvocation.artifacts.map((artifact) => artifact.contents),
    viaSaved.artifacts.map((artifact) => artifact.contents),
  );
});

test("an unrelated new child entry survives a parent's omission when resolving again", () => {
  const evolved = baseRecipes();
  evolved.effect!.artifacts = [
    {
      path: "package.json",
      contents: effectManifest.replace(
        '"effect": "4.0.0-rc.112"',
        '"effect": "4.0.0-rc.112",\n    "zod": "^4.0.0"',
      ),
    },
    { path: ".oxlintrc.jsonc", contents: effectConfig },
  ];
  const { artifacts, conflicts } = resolveRecipes(evolved, "web", [], handlers);
  assert.deepEqual(conflicts, []);
  const manifest = JSON.parse(artifacts[0]!.contents);
  assert.equal(manifest.dependencies.stripe, undefined);
  assert.equal(manifest.dependencies.zod, "^4.0.0");
});

test("composition rejects cycles and incompatible contributions; selector edits need a handler", () => {
  const cyclic: Record<string, Recipe> = {
    a: { name: "a", artifacts: [], includes: [{ recipe: "b" }] },
    b: { name: "b", artifacts: [], includes: [{ recipe: "a" }] },
  };
  assert.ok(
    resolveRecipes(cyclic, "a", [], handlers).conflicts.some((conflict) =>
      conflict.includes("cycle"),
    ),
  );

  // Identical same-path contributions dedupe; differing ones conflict with
  // both instances named. Core never picks a winner by order.
  const identical: Record<string, Recipe> = {
    a: {
      name: "a",
      artifacts: [{ path: "package.json", contents: effectManifest }],
      includes: [{ recipe: "b" }],
    },
    b: {
      name: "b",
      artifacts: [{ path: "package.json", contents: effectManifest }],
    },
  };
  assert.deepEqual(resolveRecipes(identical, "a", [], handlers).conflicts, []);

  const conflicting: Record<string, Recipe> = {
    a: {
      name: "a",
      artifacts: [{ path: "package.json", contents: `{"dependencies":{"left-pad":"^1.0.0"}}` }],
      includes: [{ recipe: "b" }],
    },
    b: {
      name: "b",
      artifacts: [{ path: "package.json", contents: `{"dependencies":{"left-pad":"^2.0.0"}}` }],
    },
  };
  const blocked = resolveRecipes(conflicting, "a", [], handlers);
  assert.ok(
    blocked.conflicts.some(
      (conflict) =>
        conflict.includes("left-pad") && conflict.includes("[a]") && conflict.includes("[a > b]"),
    ),
    blocked.conflicts.join("\n"),
  );

  const unclaimed: Record<string, Recipe> = {
    a: { name: "a", artifacts: [{ path: "vite.config.ts", contents: "export default {}" }] },
  };
  assert.ok(
    resolveRecipes(unclaimed, "a", [], handlers).conflicts.length === 0,
    "resolution only needs handlers when edits target an artifact",
  );
  assert.ok(
    resolveRecipes(
      unclaimed,
      "a",
      [
        {
          op: "omit",
          instance: ["a"],
          artifact: "vite.config.ts",
          selector: "rules",
          entry: "anything",
        },
      ],
      handlers,
    ).conflicts.some((conflict) => conflict.includes("No handler claims")),
  );
});

test("the whole-file fallback creates missing, skips identical, and conflicts on differing artifacts", async () => {
  const notes = { web: { name: "web", artifacts: [{ path: "notes.md", contents: "hello" }] } };

  // A missing artifact is created by the fallback, independent of handlers.
  await withProject(async (cwd) => {
    const prepared = await composition(cwd, notes);
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    assert.deepEqual(prepared.plan!.operations, [
      { kind: "write", path: join(cwd, "notes.md"), before: null, after: "hello" },
    ]);
  });

  // An identical artifact proposes nothing.
  await withProject(
    async (cwd) => {
      const prepared = await composition(cwd, notes);
      assert.deepEqual(prepared.conflicts, []);
      assert.deepEqual(prepared.plan!.operations, []);
    },
    { "package.json": targetManifest, ".oxlintrc.jsonc": targetConfig, "notes.md": "hello" },
  );

  // Differing content blocks before mutation.
  await withProject(
    async (cwd) => {
      const prepared = await composition(cwd, notes);
      assert.equal(prepared.plan, undefined);
      assert.ok(prepared.conflicts.some((conflict) => conflict.includes("differs")));
      assert.equal(await readFile(join(cwd, "notes.md"), "utf8"), "other");
    },
    { "package.json": targetManifest, ".oxlintrc.jsonc": targetConfig, "notes.md": "other" },
  );
});

test("repeat application after a successful apply proposes no mutations", async () => {
  await withProject(async (cwd) => {
    const recipes = baseRecipes();
    const first = await composition(cwd, recipes);
    assert.deepEqual(first.conflicts, []);
    const applied = await executePlan(first.plan!);
    assert.equal(applied.status, "applied");
    assert.deepEqual(await verify(cwd, recipes), []);

    const second = await composition(cwd, recipes);
    assert.deepEqual(second.conflicts, []);
    assert.deepEqual(second.plan!.operations, []);
    assert.deepEqual(await verify(cwd, recipes), []);

    const again = await executePlan(second.plan!);
    assert.equal(again.status, "applied");
    assert.equal(again.completed.length, 0);
  });
});

test("the adjusted-artifact validation boundary rejects invalid maps", () => {
  const invalidManifest = packageManifestHandler.validateAdjusted!(
    "package.json",
    effectManifest.replace('"effect": "4.0.0-rc.112"', '"effect": 4'),
  );
  assert.ok(invalidManifest.some((conflict) => conflict.includes("not a version string")));

  const invalidConfig = oxlintConfigHandler.validateAdjusted!(
    ".oxlintrc.jsonc",
    effectConfig.replace('"no-null": "warn"', '"no-null": "bananas"'),
  );
  assert.ok(invalidConfig.some((conflict) => conflict.includes("not a valid rule severity")));
});

test("the validation boundary blocks composition before any project mutation", async () => {
  const invalidRecipes = baseRecipes();
  invalidRecipes.effect!.artifacts = [
    {
      path: "package.json",
      contents: effectManifest.replace('"effect": "4.0.0-rc.112"', '"effect": 4'),
    },
    { path: ".oxlintrc.jsonc", contents: effectConfig },
  ];
  await withProject(async (cwd) => {
    const prepared = await composition(cwd, invalidRecipes);
    assert.equal(prepared.plan, undefined);
    assert.ok(prepared.conflicts.some((conflict) => conflict.includes("not a version string")));
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), targetManifest);
  });
});

test("omission never deletes a rule or dependency already present in the target", async () => {
  const withBoth = targetConfig.replace(
    '"no-var": "error"',
    '"no-var": "error",\n    "no-null": "warn"',
  );
  await withProject(
    async (cwd) => {
      const recipes = baseRecipes();
      const prepared = await composition(cwd, recipes);
      assert.deepEqual(prepared.conflicts, []);
      const applied = await executePlan(prepared.plan!);
      assert.equal(applied.status, "applied");
      assert.deepEqual(await verify(cwd, recipes), []);
      // SAFETY: the applied config decodes to an object whose rules map is an object.
      const rules = jsonc((await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8"))!, "applied config")
        .rules as Record<string, string>;
      assert.equal(rules["no-null"], "warn");
      assert.equal(rules["effecttsgo/leaking-requirements"], undefined);
    },
    { "package.json": targetManifest, ".oxlintrc.jsonc": withBoth },
  );
});

test("handlers never write during planning", async () => {
  await withProject(async (cwd) => {
    await composition(cwd, baseRecipes());
    // Planning is read-only: the target files still match their originals.
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), targetManifest);
    assert.equal(await readFile(join(cwd, ".oxlintrc.jsonc"), "utf8"), targetConfig);
    assert.equal(await read(join(cwd, "package.json")), targetManifest);
  });
});
