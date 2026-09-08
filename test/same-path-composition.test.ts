import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planComposition, resolveRecipes, type Recipe } from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { inMemoryEffectRecipe, versions } from "./effect-fixture.ts";
import { read } from "../src/runtime.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];
const root = "tamo-same-path";

async function withTarget(
  files: Record<string, string>,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), `${root}-`));
  try {
    for (const [path, contents] of Object.entries(files))
      await writeFile(join(cwd, path), contents);
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function manifestOf(contents: string): Record<string, unknown> {
  // SAFETY: fixtures only ever write JSON objects; JSON.parse returns unknown.
  return JSON.parse(contents) as Record<string, unknown>;
}

// A: two children contribute disjoint dependencies; the parent adds nothing.
function packagePair(
  aManifest: Record<string, unknown>,
  bManifest: Record<string, unknown>,
): Record<string, Recipe> {
  return {
    a: {
      name: "a",
      artifacts: [{ path: "package.json", contents: JSON.stringify(aManifest) }],
    },
    b: {
      name: "b",
      artifacts: [{ path: "package.json", contents: JSON.stringify(bManifest) }],
    },
    web: { name: "web", artifacts: [], includes: [{ recipe: "a" }, { recipe: "b" }] },
  };
}

test("A: disjoint package contributions combine; identical dedupes; differing conflicts", async () => {
  const recipes = packagePair(
    { dependencies: { "a-pkg": "1.0.0" } },
    { dependencies: { "b-pkg": "2.0.0" } },
  );
  const resolved = resolveRecipes(recipes, "web", [], handlers);
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(resolved.instances, [["web"], ["web", "a"], ["web", "b"]]);
  assert.equal(resolved.artifacts.length, 1);
  const combined = resolved.artifacts[0]!;
  assert.deepEqual(combined.instance, ["web"]);
  assert.deepEqual(manifestOf(combined.contents).dependencies, {
    "a-pkg": "1.0.0",
    "b-pkg": "2.0.0",
  });
  assert.ok(
    resolved.evidence.some((line) =>
      line.includes("combined 2 contributions from [web > a], [web > b]"),
    ),
    resolved.evidence.join("\n"),
  );
  // Per-instance contributions survive combination for behavior and provenance.
  assert.equal(resolved.contributions.length, 2);

  const same = packagePair(
    { dependencies: { shared: "1.0.0" } },
    { dependencies: { shared: "1.0.0" } },
  );
  const deduped = resolveRecipes(same, "web", [], handlers);
  assert.deepEqual(deduped.conflicts, []);
  assert.deepEqual(manifestOf(deduped.artifacts[0]!.contents).dependencies, { shared: "1.0.0" });

  const clashing = packagePair(
    { dependencies: { shared: "1.0.0" } },
    { dependencies: { shared: "2.0.0" } },
  );
  const blocked = resolveRecipes(clashing, "web", [], handlers);
  assert.ok(
    blocked.conflicts.some(
      (conflict) =>
        conflict.includes("shared") &&
        conflict.includes("[web > a]") &&
        conflict.includes("[web > b]"),
    ),
    blocked.conflicts.join("\n"),
  );
  await withTarget({ "package.json": `{"name":"t"}` }, async (cwd) => {
    const prepared = await planComposition({
      cwd,
      recipes: clashing,
      entry: "web",
      invocation: [],
      handlers,
      read,
    });
    assert.ok(prepared.conflicts.length > 0);
    assert.deepEqual(
      prepared.plan?.operations ?? [],
      [],
      "incompatible contributions block with zero operations",
    );
  });
});

test("A: unrelated top-level fields survive unique, dedupe identical, conflict when differing", async () => {
  const unique = packagePair(
    { dependencies: { "a-pkg": "1.0.0" }, engines: { node: ">=20" } },
    { dependencies: { "b-pkg": "2.0.0" } },
  );
  const resolved = resolveRecipes(unique, "web", [], handlers);
  assert.deepEqual(resolved.conflicts, []);
  assert.deepEqual(manifestOf(resolved.artifacts[0]!.contents).engines, { node: ">=20" });

  const clashing = packagePair({ engines: { node: ">=20" } }, { engines: { node: ">=22" } });
  const blocked = resolveRecipes(clashing, "web", [], handlers);
  assert.ok(
    blocked.conflicts.some(
      (conflict) => conflict.includes("engines") && conflict.includes("[web > a]"),
    ),
    blocked.conflicts.join("\n"),
  );
});

test("A: scripts and scalars combine without composing commands", async () => {
  const recipes = packagePair(
    { scripts: { build: "tsc" }, version: "1.0.0" },
    { scripts: { test: "vitest run" }, version: "1.0.0" },
  );
  const resolved = resolveRecipes(recipes, "web", [], handlers);
  assert.deepEqual(resolved.conflicts, [], resolved.conflicts.join("\n"));
  assert.deepEqual(manifestOf(resolved.artifacts[0]!.contents).scripts, {
    build: "tsc",
    test: "vitest run",
  });
  // SAFETY: the combined manifest carries the scalar this test contributed.
  assert.equal(manifestOf(resolved.artifacts[0]!.contents).version as string, "1.0.0");

  const clashingScripts = packagePair(
    { scripts: { build: "tsc" } },
    { scripts: { build: "esbuild" } },
  );
  const blockedScripts = resolveRecipes(clashingScripts, "web", [], handlers);
  assert.ok(
    blockedScripts.conflicts.some((conflict) => conflict.includes("composing commands")),
    blockedScripts.conflicts.join("\n"),
  );

  const clashingScalar = packagePair({ version: "1.0.0" }, { version: "2.0.0" });
  const blockedScalar = resolveRecipes(clashingScalar, "web", [], handlers);
  assert.ok(
    blockedScalar.conflicts.some((conflict) => conflict.includes("version")),
    blockedScalar.conflicts.join("\n"),
  );
});

function configPair(
  aConfig: Record<string, unknown>,
  bConfig: Record<string, unknown>,
): Record<string, Recipe> {
  return {
    a: {
      name: "a",
      artifacts: [{ path: ".oxlintrc.jsonc", contents: JSON.stringify(aConfig) }],
    },
    b: {
      name: "b",
      artifacts: [{ path: ".oxlintrc.jsonc", contents: JSON.stringify(bConfig) }],
    },
    web: { name: "web", artifacts: [], includes: [{ recipe: "a" }, { recipe: "b" }] },
  };
}

test("B: independent and identical-nested rules combine; differing rules conflict", async () => {
  const recipes = configPair(
    { rules: { "a-rule": "error", shared: ["warn", { extra: true }] } },
    { rules: { "b-rule": "error", shared: ["warn", { extra: true }] } },
  );
  const resolved = resolveRecipes(recipes, "web", [], handlers);
  assert.deepEqual(resolved.conflicts, [], resolved.conflicts.join("\n"));
  assert.deepEqual(JSON.parse(resolved.artifacts[0]!.contents).rules, {
    "a-rule": "error",
    shared: ["warn", { extra: true }],
    "b-rule": "error",
  });

  const clashing = configPair(
    { rules: { shared: ["warn", { extra: true }] } },
    { rules: { shared: ["warn", { extra: false }] } },
  );
  const blocked = resolveRecipes(clashing, "web", [], handlers);
  assert.ok(
    blocked.conflicts.some(
      (conflict) =>
        conflict.includes("shared") &&
        conflict.includes("[web > a]") &&
        conflict.includes("[web > b]"),
    ),
    blocked.conflicts.join("\n"),
  );
});

test("B: order-sensitive overlapping structures conflict rather than choosing order", async () => {
  for (const field of ["plugins", "extends", "overrides"] as const) {
    const aValue = field === "overrides" ? [{ files: ["*.ts"], rules: {} }] : ["x"];
    const bValue = field === "overrides" ? [{ files: ["*.mts"], rules: {} }] : ["x", "y"];
    const clashing = configPair({ [field]: aValue }, { [field]: bValue });
    const blocked = resolveRecipes(clashing, "web", [], handlers);
    assert.ok(
      blocked.conflicts.some((conflict) => conflict.includes(field)),
      `${field}: ${blocked.conflicts.join("\n")}`,
    );
  }
  // Identical collections dedupe; lone collections are preserved.
  const same = configPair({ plugins: ["x"] }, { plugins: ["x"] });
  const deduped = resolveRecipes(same, "web", [], handlers);
  assert.deepEqual(deduped.conflicts, []);
  assert.deepEqual(JSON.parse(deduped.artifacts[0]!.contents).plugins, ["x"]);

  const lone = configPair({ plugins: ["x"] }, { rules: { "a-rule": "error" } });
  const kept = resolveRecipes(lone, "web", [], handlers);
  assert.deepEqual(kept.conflicts, []);
  assert.deepEqual(JSON.parse(kept.artifacts[0]!.contents).plugins, ["x"]);
});

test("B: jsPlugins dedupe identical registrations and conflict on identity collision", async () => {
  const entry = { name: "plug", specifier: "./plug.ts" };
  const same = configPair({ jsPlugins: [entry] }, { jsPlugins: [entry] });
  const deduped = resolveRecipes(same, "web", [], handlers);
  assert.deepEqual(deduped.conflicts, []);
  assert.deepEqual(JSON.parse(deduped.artifacts[0]!.contents).jsPlugins, [entry]);

  const clashing = configPair(
    { jsPlugins: [{ name: "plug", specifier: "./one.ts" }] },
    { jsPlugins: [{ name: "plug", specifier: "./two.ts" }] },
  );
  const blocked = resolveRecipes(clashing, "web", [], handlers);
  assert.ok(
    blocked.conflicts.some((conflict) => conflict.includes("plug")),
    blocked.conflicts.join("\n"),
  );
});

test("C: duplicate child names under one parent fail loudly", async () => {
  const recipes: Record<string, Recipe> = {
    a: { name: "a", artifacts: [] },
    web: {
      name: "web",
      artifacts: [],
      includes: [{ recipe: "a" }, { recipe: "a" }],
    },
  };
  const resolved = resolveRecipes(recipes, "web", [], handlers);
  assert.ok(
    resolved.conflicts.some((conflict) => conflict.includes("more than once")),
    resolved.conflicts.join("\n"),
  );
});

test("D: parent omissions apply to one child before sibling combination", async () => {
  const recipes: Record<string, Recipe> = {
    effect: {
      name: "effect",
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({ dependencies: { "a-pkg": "1.0.0", "b-pkg": "1.0.0" } }),
        },
      ],
    },
    sibling: {
      name: "sibling",
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({ dependencies: { "b-pkg": "9.0.0", "c-pkg": "1.0.0" } }),
        },
      ],
    },
    web: {
      name: "web",
      artifacts: [],
      includes: [{ recipe: "effect" }, { recipe: "sibling" }],
      customizations: [
        {
          op: "omit",
          instance: ["effect"],
          artifact: "package.json",
          selector: "dependencies",
          entry: "b-pkg",
        },
      ],
    },
  };
  const resolved = resolveRecipes(recipes, "web", [], handlers);
  assert.deepEqual(resolved.conflicts, [], resolved.conflicts.join("\n"));
  // The parent's omit removed only the child's B; the sibling's own B stays.
  assert.deepEqual(manifestOf(resolved.artifacts[0]!.contents).dependencies, {
    "a-pkg": "1.0.0",
    "b-pkg": "9.0.0",
    "c-pkg": "1.0.0",
  });

  // The child later gains D; re-resolution yields A+C+D with no parent change.
  const grown: Record<string, Recipe> = {
    ...recipes,
    effect: {
      name: "effect",
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({
            dependencies: { "a-pkg": "1.0.0", "b-pkg": "1.0.0", "d-pkg": "1.0.0" },
          }),
        },
      ],
    },
  };
  const reResolved = resolveRecipes(grown, "web", [], handlers);
  assert.deepEqual(reResolved.conflicts, [], reResolved.conflicts.join("\n"));
  assert.deepEqual(manifestOf(reResolved.artifacts[0]!.contents).dependencies, {
    "a-pkg": "1.0.0",
    "d-pkg": "1.0.0",
    "b-pkg": "9.0.0",
    "c-pkg": "1.0.0",
  });
});

test("E: unhandled files dedupe when identical and conflict when differing", async () => {
  const pair = (contents: string): Record<string, Recipe> => ({
    a: { name: "a", artifacts: [{ path: "notes.md", contents }] },
    b: { name: "b", artifacts: [{ path: "notes.md", contents }] },
    web: { name: "web", artifacts: [], includes: [{ recipe: "a" }, { recipe: "b" }] },
  });
  const same = resolveRecipes(pair("hello\n"), "web", [], handlers);
  assert.deepEqual(same.conflicts, []);
  assert.equal(same.artifacts.length, 1);
  assert.equal(same.artifacts[0]!.contents, "hello\n");

  await withTarget({}, async (cwd) => {
    const prepared = await planComposition({
      cwd,
      recipes: pair("hello\n"),
      entry: "web",
      invocation: [],
      handlers,
      read,
    });
    assert.deepEqual(prepared.conflicts, []);
    assert.deepEqual(prepared.plan!.operations.length, 1);
  });

  const clashing: Record<string, Recipe> = {
    a: { name: "a", artifacts: [{ path: "notes.md", contents: "X\n" }] },
    b: { name: "b", artifacts: [{ path: "notes.md", contents: "Y\n" }] },
    web: { name: "web", artifacts: [], includes: [{ recipe: "a" }, { recipe: "b" }] },
  };
  const blocked = resolveRecipes(clashing, "web", [], handlers);
  assert.ok(
    blocked.conflicts.some(
      (conflict) =>
        conflict.includes("notes.md") &&
        conflict.includes("[web > a]") &&
        conflict.includes("[web > b]"),
    ),
    blocked.conflicts.join("\n"),
  );
  await withTarget({}, async (cwd) => {
    const prepared = await planComposition({
      cwd,
      recipes: clashing,
      entry: "web",
      invocation: [],
      handlers,
      read,
    });
    assert.ok(prepared.conflicts.length > 0);
    assert.deepEqual(prepared.plan?.operations ?? [], []);
  });
});

test("G: combined contributions apply to an existing target without silent drops", async () => {
  const recipes = packagePair(
    { dependencies: { kept: "1.0.0", fresh: "1.0.0" } },
    { dependencies: { fresh: "1.0.0", other: "3.0.0" } },
  );
  await withTarget(
    { "package.json": `{"name":"t","dependencies":{"kept":"1.0.0"}}` },
    async (cwd) => {
      const prepared = await planComposition({
        cwd,
        recipes,
        entry: "web",
        invocation: [],
        handlers,
        read,
      });
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      const write = prepared.plan!.operations.find(
        (operation) => operation.kind === "write" && operation.path.endsWith("package.json"),
      );
      if (!write || write.kind !== "write") assert.fail("expected a package.json write");
      assert.deepEqual(JSON.parse(write.after).dependencies, {
        kept: "1.0.0",
        fresh: "1.0.0",
        other: "3.0.0",
      });
      assert.ok(
        prepared.plan!.evidence.some((line) => line.includes("already declared")),
        prepared.plan!.evidence.join("\n"),
      );
    },
  );

  // A combined contribution the target cannot honor blocks with zero operations.
  const clashing = packagePair(
    { dependencies: { kept: "2.0.0" } },
    { dependencies: { fresh: "1.0.0" } },
  );
  await withTarget(
    { "package.json": `{"name":"t","dependencies":{"kept":"1.0.0"}}` },
    async (cwd) => {
      const prepared = await planComposition({
        cwd,
        recipes: clashing,
        entry: "web",
        invocation: [],
        handlers,
        read,
      });
      assert.ok(
        prepared.conflicts.some((conflict) => conflict.includes("kept")),
        prepared.conflicts.join("\n"),
      );
      assert.deepEqual(prepared.plan?.operations ?? [], []);
    },
  );
});

test("F: Effect behavior plans over combined same-path contributions", async () => {
  const cwd = join(tmpdir(), `${root}-behavior`);
  const files = new Map<string, string>([
    [
      join(cwd, "package.json"),
      JSON.stringify({
        name: "t",
        packageManager: "pnpm@10.11.0",
        dependencies: { effect: versions.effect },
        devDependencies: { oxlint: versions.oxlint },
      }),
    ],
    [join(cwd, ".oxlintrc.json"), `{"rules":{}}`],
    ...["effect", "oxlint"].map((name): [string, string] => [
      join(cwd, `node_modules/${name}/package.json`),
      JSON.stringify({ version: versions[name] }),
    ]),
  ]);
  const context = { cwd, read: async (path: string) => files.get(path) ?? null };
  const recipes: Record<string, Recipe> = {
    "effect-oxlint": await inMemoryEffectRecipe(),
    vitest: {
      name: "vitest",
      artifacts: [
        {
          path: "package.json",
          contents: JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
        },
      ],
    },
    web: {
      name: "web",
      artifacts: [],
      includes: [{ recipe: "effect-oxlint" }, { recipe: "vitest" }],
    },
  };
  const prepared = await planComposition({
    ...context,
    recipes,
    entry: "web",
    invocation: [],
    handlers,
  });
  assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
  const plan = prepared.plan!;

  // The combined manifest write carries both recipes' dependencies.
  const manifest = plan.operations.find(
    (operation) => operation.kind === "write" && operation.path.endsWith("package.json"),
  );
  if (!manifest || manifest.kind !== "write") assert.fail("expected a package.json write");
  // SAFETY: the planned manifest write always carries a devDependencies map here.
  const contributed = JSON.parse(manifest.after).devDependencies as Record<string, string>;
  assert.equal(contributed.vitest, "^3.0.0");
  assert.equal(contributed["@effect/tsgo"], versions["@effect/tsgo"]);

  // All artifact writes precede the behavior commands, which still plan.
  const kinds = plan.operations.map((operation) => operation.kind);
  const lastWrite = kinds.lastIndexOf("write");
  const firstCommand = kinds.indexOf("command");
  assert.ok(lastWrite >= 0 && firstCommand > lastWrite);
  assert.deepEqual(
    plan.operations
      .filter((operation) => operation.kind === "command")
      .map((operation) => (operation.kind === "command" ? operation.args : [])),
    [
      ["install", "--ignore-scripts"],
      ["exec", "effect-tsgo", "patch", "--no-typescript", "--oxlint"],
    ],
  );
  assert.ok(
    plan.evidence.some((line) =>
      line.includes("combined 2 contributions from [web > effect-oxlint], [web > vitest]"),
    ),
    plan.evidence.join("\n"),
  );

  // The applied artifact writes replan to zero further writes: combination is idempotent.
  for (const operation of plan.operations) {
    if (operation.kind !== "write" || operation.after === null) continue;
    files.set(operation.path, operation.after);
  }
  const replan = await planComposition({
    ...context,
    recipes,
    entry: "web",
    invocation: [],
    handlers,
  });
  assert.deepEqual(replan.conflicts, [], replan.conflicts.join("\n"));
  assert.deepEqual(
    replan.plan!.operations.filter((operation) => operation.kind === "write"),
    [],
  );
});

test("F: behavior conflicts still block the whole combined plan with zero operations", async () => {
  const cwd = join(tmpdir(), `${root}-behavior-blocked`);
  // The target never declared Effect, so the behavior's preconditions fail
  // even though the artifact contributions would combine cleanly.
  const files = new Map<string, string>([
    [
      join(cwd, "package.json"),
      JSON.stringify({
        name: "t",
        packageManager: "pnpm@10.11.0",
        devDependencies: { oxlint: versions.oxlint },
      }),
    ],
    [join(cwd, ".oxlintrc.json"), `{"rules":{}}`],
    [join(cwd, "node_modules/oxlint/package.json"), JSON.stringify({ version: versions.oxlint })],
  ]);
  const prepared = await planComposition({
    cwd,
    recipes: {
      "effect-oxlint": await inMemoryEffectRecipe(),
      vitest: {
        name: "vitest",
        artifacts: [
          {
            path: "package.json",
            contents: JSON.stringify({ devDependencies: { vitest: "^3.0.0" } }),
          },
        ],
      },
      web: {
        name: "web",
        artifacts: [],
        includes: [{ recipe: "effect-oxlint" }, { recipe: "vitest" }],
      },
    },
    entry: "web",
    invocation: [],
    handlers,
    read: async (path: string) => files.get(path) ?? null,
  });
  assert.ok(
    prepared.conflicts.some((conflict) => conflict.includes("effect")),
    prepared.conflicts.join("\n"),
  );
  assert.deepEqual(prepared.plan?.operations ?? [], []);
});
