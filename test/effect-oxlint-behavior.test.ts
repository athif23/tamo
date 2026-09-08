import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inMemoryEffectRecipe, loadProbeExpectations, versions } from "./effect-fixture.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { planComposition, verifyComposition, type Recipe } from "../src/compose.ts";
import { json as jsonc } from "../src/jsonc.ts";
import { executePlan, read } from "../src/runtime.ts";
import type { Plan } from "../src/plan.ts";

// Regression coverage for the effect-oxlint recipe path: recipe + handlers +
// behavior must plan the same mutations and commands, or block for the
// documented reasons, on identical project state.
const root = resolve("test/fixtures/project");
const fixtureConfig =
  '// Keep this comment\n{ "rules": { "eslint/no-debugger": "error" }, "overrides": [{ "files": ["*.js"], "rules": { "eslint/no-var": "error" } }] }';

function fixture(config = fixtureConfig, prepare = "node setup.mjs") {
  const files = new Map<string, string>([
    [
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.11.0",
        dependencies: { effect: versions.effect },
        devDependencies: { oxlint: versions.oxlint },
        scripts: { prepare },
      }),
    ],
    [join(root, ".oxlintrc.jsonc"), config],
    ...["effect", "oxlint"].map((name): [string, string] => [
      join(root, `node_modules/${name}/package.json`),
      JSON.stringify({ version: versions[name] }),
    ]),
  ]);
  return { files, context: { cwd: root, read: async (path: string) => files.get(path) ?? null } };
}

async function planRecipe(context: {
  cwd: string;
  read: (path: string) => Promise<string | null>;
}) {
  return planComposition({
    cwd: context.cwd,
    recipes: { "effect-oxlint": await inMemoryEffectRecipe() },
    entry: "effect-oxlint",
    invocation: [],
    handlers: [packageManifestHandler, oxlintConfigHandler],
    read: context.read,
  });
}

function writes(plan: Plan) {
  return plan.operations
    .filter((operation) => operation.kind === "write")
    .map((operation) =>
      operation.kind === "write"
        ? { path: operation.path, before: operation.before, after: operation.after }
        : null,
    )
    .sort((a, b) => a!.path.localeCompare(b!.path));
}

function commands(plan: Plan) {
  return plan.operations
    .filter((operation) => operation.kind === "command")
    .map((operation) => (operation.kind === "command" ? { args: operation.args } : null));
}

test("recipe + handlers + behavior plans additive writes and install/patch commands", async () => {
  const { files, context } = fixture();
  const before = [...files];
  const prepared = await planRecipe(context);
  assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
  // Planning is read-only.
  assert.deepEqual([...files], before);

  const plan = prepared.plan!;
  assert.deepEqual(
    writes(plan).map((write) => write!.path.replaceAll("\\", "/")),
    [
      `${root}/.config/oxlint/tamo-effect.ts`.replaceAll("\\", "/"),
      `${root}/.oxlintrc.jsonc`.replaceAll("\\", "/"),
      `${root}/package.json`.replaceAll("\\", "/"),
    ],
  );
  assert.deepEqual(commands(plan), [
    { args: ["install", "--ignore-scripts"] },
    { args: ["exec", "effect-tsgo", "patch", "--no-typescript", "--oxlint"] },
  ]);

  const manifest = writes(plan).find((write) => write!.path.endsWith("package.json"))!;
  assert.equal(
    JSON.parse(manifest!.after).scripts.prepare,
    "node setup.mjs && effect-tsgo patch --no-typescript --oxlint",
  );
  assert.deepEqual(JSON.parse(manifest!.after).devDependencies, {
    oxlint: versions.oxlint,
    "@effect/tsgo": versions["@effect/tsgo"],
    "oxlint-tsgolint": versions["oxlint-tsgolint"],
    "@oxlint/plugins": versions["@oxlint/plugins"],
  });
  const config = writes(plan).find((write) => write!.path.endsWith(".jsonc"))!;
  assert.ok(config!.after.startsWith("// Keep this comment"));
});

test("the custom plugin source is recipe artifact data applied by the Core fallback", async () => {
  const { context } = fixture();
  const recipe = await inMemoryEffectRecipe();
  assert.deepEqual(
    recipe.artifacts.map((artifact) => artifact.path),
    ["package.json", ".oxlintrc.json", ".config/oxlint/tamo-effect.ts"],
  );
  const pluginArtifact = recipe.artifacts.find((artifact) =>
    artifact.path.endsWith("tamo-effect.ts"),
  )!;

  const migrated = await planRecipe(context);
  const pluginWrite = writes(migrated.plan!).find((write) =>
    write!.path.endsWith("tamo-effect.ts"),
  )!;
  // The plugin arrives through Core's whole-file fallback carrying the
  // recipe's own bytes — the behavior contributes commands only.
  assert.deepEqual(pluginWrite, {
    path: join(root, ".config/oxlint/tamo-effect.ts"),
    before: null,
    after: pluginArtifact.contents,
  });
});

test("behavior commands are planned after all artifact writes", async () => {
  const { context } = fixture();
  const plan = (await planRecipe(context)).plan!;
  const kinds = plan.operations.map((operation) => operation.kind);
  assert.deepEqual(kinds, ["write", "write", "write", "command", "command"]);
  assert.ok(kinds.lastIndexOf("write") < kinds.indexOf("command"));
  const inputPaths = plan.inputs.map((input) => input.path.replaceAll("\\", "/"));
  assert.ok(inputPaths.some((path) => path.includes("node_modules/effect")));
});

const pluginFile = join(root, ".config/oxlint/tamo-effect.ts");

const blockingScenarios: Array<{
  name: string;
  config?: string;
  prepare?: string;
  setup?: (files: Map<string, string>) => void;
  check?: (plan: { conflicts: string[] }) => boolean;
}> = [
  { name: "explicit rule differs", config: '{"rules":{"effecttsgo/strict-effect-provide":"off"}}' },
  {
    name: "upstream preset rule differs",
    config: '{"rules":{"effecttsgo/floating-effect":"off"}}',
  },
  {
    name: "unrelated override touches a contributed rule",
    config:
      '{"overrides":[{"files":["src/**"],"rules":{"effecttsgo/strict-effect-provide":"off"}}]}',
  },
  { name: "typeAware disabled", config: '{"options":{"typeAware":false}}' },
  { name: "non-relative extends", config: '{"extends":["external-preset"]}' },
  { name: "unsupported prepare script", prepare: "node setup.mjs || exit 0" },
  {
    name: "existing plugin contents differ",
    check: (plan) => plan.conflicts.some((v) => v.includes("differs")),
    setup: (files) => files.set(pluginFile, "// User's plugin"),
  },
  {
    name: "incompatible effect version",
    check: (plan) => plan.conflicts.some((v) => v.includes("3.0.0")),
    setup: (files) =>
      files.set(join(root, "node_modules/effect/package.json"), '{"version":"3.0.0"}'),
  },
  {
    name: "ambiguous oxlint config",
    check: (plan) => plan.conflicts.some((v) => v.includes("exactly one")),
    setup: (files) => files.set(join(root, ".oxlintrc.json"), "{}"),
  },
  {
    name: "parent pnpm workspace",
    check: (plan) => plan.conflicts.some((v) => v.includes("parent pnpm workspace")),
    setup: (files) =>
      files.set(join(dirname(root), "pnpm-workspace.yaml"), "packages: ['project']"),
  },
  {
    name: "inherited config changes plugins",
    config: '{"extends":["./base.json"]}',
    check: (plan) => plan.conflicts.some((v) => v.includes("Inherited plugin/options")),
    setup: (files) => files.set(join(root, "base.json"), '{"plugins":["react"]}'),
  },
];

async function assertBlocksForReason(
  preparation: { conflicts: string[] },
  scenario: (typeof blockingScenarios)[number],
): Promise<void> {
  assert.ok(preparation.conflicts.length, `blocks: ${scenario.name}`);
  if (scenario.check) assert.ok(scenario.check(preparation), `matches: ${scenario.name}`);
}

test("the recipe path blocks with zero operations for conflicting state", async () => {
  for (const scenario of blockingScenarios) {
    const prepare = scenario.prepare ?? "node setup.mjs";
    const migratedFixture = fixture(scenario.config ?? fixtureConfig, prepare);
    scenario.setup?.(migratedFixture.files);
    const migrated = await planRecipe(migratedFixture.context);
    await assertBlocksForReason(migrated, scenario);
    assert.deepEqual(
      migrated.plan?.operations ?? [],
      [],
      `blocked plans propose zero operations: ${scenario.name}`,
    );
  }
});

test("handlers propose no mutations against an already-applied project", async () => {
  // Replay the recipe plan's own writes as the satisfied post-application
  // state, so handler idempotence is measured against the recipe path alone.
  const { files, context } = fixture();
  const first = await planRecipe(context);
  assert.deepEqual(first.conflicts, [], first.conflicts.join("\n"));
  for (const operation of first.plan!.operations)
    if (operation.kind === "write") files.set(operation.path, operation.after);
  for (const [name, version] of Object.entries(versions))
    files.set(join(root, `node_modules/${name}/package.json`), JSON.stringify({ version }));

  const recipe = await inMemoryEffectRecipe();
  const composition = await planComposition({
    cwd: root,
    recipes: { "effect-oxlint": recipe },
    entry: "effect-oxlint",
    invocation: [],
    handlers: [packageManifestHandler, oxlintConfigHandler],
    read: context.read,
  });
  assert.deepEqual(composition.conflicts, [], composition.conflicts.join("\n"));
  assert.deepEqual(composition.plan!.operations, []);
});

test("recipe artifacts carry the Effect opinion; handlers stay generic", async () => {
  const recipe = await inMemoryEffectRecipe();
  const manifest = JSON.parse(recipe.artifacts[0]!.contents);
  assert.deepEqual(manifest.devDependencies, {
    "@effect/tsgo": versions["@effect/tsgo"],
    "oxlint-tsgolint": versions["oxlint-tsgolint"],
    "@oxlint/plugins": versions["@oxlint/plugins"],
  });
  assert.equal(manifest.scripts.prepare, "effect-tsgo patch --no-typescript --oxlint");
  assert.equal(manifest.dependencies, undefined);

  const config = JSON.parse(recipe.artifacts[1]!.contents);
  assert.deepEqual(config.plugins, ["typescript", "oxc", "unicorn", "effecttsgo"]);
  assert.equal(config.options.typeAware, true);
  assert.deepEqual(config.jsPlugins, [
    { name: "tamo-effect", specifier: "./.config/oxlint/tamo-effect.ts" },
  ]);
  assert.deepEqual(Object.keys(config.rules), [
    "effecttsgo/strict-effect-provide",
    "effecttsgo/run-effect-inside-effect",
    "effecttsgo/try-catch-in-effect-gen",
    "effecttsgo/multiple-effect-provide",
    "effecttsgo/scope-in-layer-effect",
    "effecttsgo/layer-merge-all-with-dependencies",
    "effecttsgo/leaking-requirements",
    "tamo-effect/no-layer-in-service-class",
  ]);
  assert.deepEqual(config.overrides, [
    { files: ["**/test/**", "scripts/**"], rules: { "effecttsgo/strict-effect-provide": "off" } },
  ]);

  // The recipe's dependency versions stay consistent: the artifact carries
  // the same pins the recipe exports for fixtures and probes.
  assert.deepEqual(manifest.devDependencies, {
    "@effect/tsgo": versions["@effect/tsgo"],
    "oxlint-tsgolint": versions["oxlint-tsgolint"],
    "@oxlint/plugins": versions["@oxlint/plugins"],
  });
});

test("reviewed input recheck covers behavior planning reads", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tamo-behavior-recheck-"));
  try {
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.11.0",
        dependencies: { effect: versions.effect },
        devDependencies: { oxlint: versions.oxlint },
      }),
    );
    for (const [name, version] of Object.entries(versions)) {
      if (name === "@effect/tsgo" || name === "oxlint-tsgolint" || name === "@oxlint/plugins")
        continue;
      await mkdir(dirname(join(cwd, `node_modules/${name}/package.json`)), { recursive: true });
      await writeFile(join(cwd, `node_modules/${name}/package.json`), JSON.stringify({ version }));
    }
    await writeFile(join(cwd, ".oxlintrc.jsonc"), "{}\n");

    const prepared = await planComposition({
      cwd,
      recipes: { "effect-oxlint": await inMemoryEffectRecipe() },
      entry: "effect-oxlint",
      invocation: [],
      handlers: [packageManifestHandler, oxlintConfigHandler],
      read,
    });
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    const plan = prepared.plan!;
    // Behavior reads (installed package versions) participate alongside the
    // handlers' artifact reads.
    const inputPaths = plan.inputs.map((input) => input.path.replaceAll("\\", "/"));
    assert.ok(inputPaths.some((path) => path.endsWith("node_modules/effect/package.json")));
    assert.ok(inputPaths.some((path) => path.endsWith(".oxlintrc.jsonc")));

    await writeFile(
      join(cwd, "node_modules/effect/package.json"),
      JSON.stringify({ version: "3.0.0" }),
    );
    const result = await executePlan(plan);
    assert.equal(result.status, "failed");
    assert.equal(result.completed.length, 0);
    assert.ok(result.errors.some((error) => error.includes("Input changed")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a behavior attached to an included child runs when the parent recipe is planned", async () => {
  const { context } = fixture();
  const prepared = await planComposition({
    cwd: context.cwd,
    recipes: {
      web: { name: "web", artifacts: [], includes: [{ recipe: "effect-oxlint" }] },
      "effect-oxlint": await inMemoryEffectRecipe(),
    },
    entry: "web",
    invocation: [],
    handlers: [packageManifestHandler, oxlintConfigHandler],
    read: context.read,
  });
  assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
  const plan = prepared.plan!;
  const kinds = plan.operations.map((operation) => operation.kind);
  assert.deepEqual(kinds, ["write", "write", "write", "command", "command"]);
  // The child behavior's environment reads ran: its observations are tracked.
  const inputPaths = plan.inputs.map((input) => input.path.replaceAll("\\", "/"));
  assert.ok(inputPaths.some((path) => path.includes("node_modules/effect")));
});

test("commandless behavior-bearing instances resolve together", async () => {
  const behavior = { finalize: async () => ({ conflicts: [], evidence: [], operations: [] }) };
  const prepared = await planComposition({
    cwd: root,
    recipes: {
      a: { name: "a", artifacts: [], includes: [{ recipe: "b" }], behavior },
      b: { name: "b", artifacts: [], behavior },
    },
    entry: "a",
    invocation: [],
    handlers: [],
    read: async () => null,
  });
  assert.deepEqual(prepared.conflicts, []);
  assert.deepEqual(prepared.plan!.operations, []);
});

test("multiple post-artifact command producers block explicitly", async () => {
  const command = (name: string) => ({
    kind: "command" as const,
    executable: process.execPath,
    args: ["--version"],
    cwd: root,
    purpose: name,
  });
  const behavior = (name: string) => ({
    finalize: async () => ({ conflicts: [], evidence: [], operations: [command(name)] }),
  });
  const prepared = await planComposition({
    cwd: root,
    recipes: {
      a: {
        name: "a",
        artifacts: [],
        includes: [{ recipe: "b" }],
        behavior: behavior("from-a"),
      },
      b: { name: "b", artifacts: [], behavior: behavior("from-b") },
    },
    entry: "a",
    invocation: [],
    handlers: [],
    read: async () => null,
  });
  assert.equal(prepared.plan, undefined);
  assert.ok(
    prepared.conflicts.some(
      (conflict) =>
        conflict.includes("Multiple behavior-bearing recipe instances") &&
        conflict.includes("[a]") &&
        conflict.includes("[a > b]") &&
        conflict.includes("post-artifact command order is unsupported"),
    ),
    prepared.conflicts.join("\n"),
  );
});

test("verification receives the behavior-owning instance's resolved intent", async () => {
  const seen: Array<{ cwd: string; instance: string[]; artifacts: unknown[] }> = [];
  const recipes: Record<string, Recipe> = {
    web: { name: "web", artifacts: [], includes: [{ recipe: "effect" }] },
    effect: {
      name: "effect",
      artifacts: [{ path: "notes.md", contents: "hello" }],
      behavior: {
        verify: async (context) => {
          seen.push(context);
          return [];
        },
      },
    },
  };
  const cwd = await mkdtemp(join(tmpdir(), "tamo-verify-intent-"));
  try {
    await writeFile(join(cwd, "notes.md"), "hello");
    const prepared = await planComposition({
      cwd,
      recipes,
      entry: "web",
      invocation: [],
      handlers: [],
      read,
    });
    assert.deepEqual(prepared.conflicts, []);
    assert.deepEqual(prepared.plan!.operations, []);
    const errors = await verifyComposition({
      cwd,
      recipes,
      entry: "web",
      invocation: [],
      handlers: [],
      read,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(seen[0]!.instance, ["web", "effect"]);
    assert.deepEqual(seen[0]!.artifacts, [{ path: "notes.md", contents: "hello" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("planning and verification derive from the same customized intent", async () => {
  // Default resolved intent: all three probe-relevant diagnostics are
  // required, with the test exception for strict-effect-provide.
  const probeExpectations = await loadProbeExpectations();
  const recipe = await inMemoryEffectRecipe();
  const defaultExpectations = probeExpectations(JSON.parse(recipe.artifacts[1]!.contents));
  assert.deepEqual(
    new Set(defaultExpectations.ordinary),
    new Set([
      "effecttsgo(floating-effect)",
      "effecttsgo(strict-effect-provide)",
      "tamo-effect(no-layer-in-service-class)",
    ]),
  );
  assert.deepEqual(
    new Set(defaultExpectations.test),
    new Set(["effecttsgo(floating-effect)", "tamo-effect(no-layer-in-service-class)"]),
  );

  // A temporary invocation omission changes the resolved intent: the plan
  // no longer contributes the rule, and verification no longer requires it.
  const { context } = fixture();
  const prepared = await planComposition({
    cwd: context.cwd,
    recipes: { "effect-oxlint": recipe },
    entry: "effect-oxlint",
    invocation: [
      {
        op: "omit",
        instance: ["effect-oxlint"],
        artifact: ".oxlintrc.json",
        selector: "rules",
        entry: "tamo-effect/no-layer-in-service-class",
      },
    ],
    handlers: [packageManifestHandler, oxlintConfigHandler],
    read: context.read,
  });
  assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
  const configWrite = writes(prepared.plan!).find((write) => write!.path.endsWith(".jsonc"))!;
  // SAFETY: the applied config decodes to an object whose rules map is an object.
  const appliedRules = jsonc(configWrite!.after, "applied config").rules as Record<string, string>;
  assert.equal(appliedRules["tamo-effect/no-layer-in-service-class"], undefined);

  const expectations = probeExpectations(jsonc(configWrite!.after, "applied config"));
  assert.ok(!expectations.ordinary.includes("tamo-effect(no-layer-in-service-class)"));
  assert.ok(!expectations.test.includes("tamo-effect(no-layer-in-service-class)"));
  assert.ok(expectations.ordinary.includes("effecttsgo(strict-effect-provide)"));
  assert.ok(expectations.ordinary.includes("effecttsgo(floating-effect)"));
});
