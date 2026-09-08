// Deterministic coverage for the shadcn smoke experiment's local logic
// (network-free): the pinned invocation, the components.json gate, the
// stage-1 plan shape, and the recipe combination. The live CLI run itself
// stays behind pnpm test:smoke-shadcn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planComposition, resolveRecipes, type RecipeContext } from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { read } from "../src/runtime.ts";
import {
  SHADCN_PROJECT,
  SHADCN_VERSION,
  shadcnExperimentRecipes,
  shadcnInitArgs,
  shadcnPrepare,
} from "./shadcn-smoke.ts";

const handlers = [packageManifestHandler, oxlintConfigHandler];

function stubContext(readFile: (path: string) => Promise<string | null>): RecipeContext {
  return {
    cwd: "smoke",
    instance: ["web", "shadcn-app"],
    artifacts: [],
    read: readFile,
    track: () => {},
  };
}

test("the shadcn invocation is pinned exactly", async () => {
  assert.deepEqual(shadcnInitArgs("/tmp/workspace"), [
    "dlx",
    `shadcn@${SHADCN_VERSION}`,
    "init",
    "--template",
    "vite",
    "--yes",
    "--base",
    "base",
    "--preset",
    "nova",
    "--name",
    SHADCN_PROJECT,
    "--no-monorepo",
    "--no-rtl",
    "--no-pointer",
    "--no-reinstall",
    "--cwd",
    "/tmp/workspace",
  ]);
  assert.equal(SHADCN_VERSION, "4.21.0");
});

test("the prepare gate plans the initializer only while components.json is absent", async () => {
  const behavior = shadcnPrepare("pnpm-js", ["dlx", "shadcn@4.21.0"], "/tmp/workspace");
  if (!behavior.prepare) assert.fail("expected a prepare hook");
  const planned = await behavior.prepare(stubContext(async () => null));
  assert.deepEqual(planned.conflicts, []);
  assert.equal(planned.operations.length, 1);
  const command = planned.operations[0]!;
  assert.equal(command.kind, "command");
  if (command.kind !== "command") assert.fail("expected a command operation");
  assert.equal(command.executable, "pnpm-js");
  assert.deepEqual(command.args, ["dlx", "shadcn@4.21.0"]);
  assert.equal(command.cwd, "/tmp/workspace");

  const settled = await behavior.prepare(stubContext(async () => "{}"));
  assert.deepEqual(settled.conflicts, []);
  assert.deepEqual(settled.operations, []);
});

test("stage-1 planning stays command-only without touching the network", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tamo-shadcn-gate-"));
  try {
    const recipes = shadcnExperimentRecipes("node", ["--version"], workspace);
    const prepared = await planComposition({
      cwd: join(workspace, SHADCN_PROJECT),
      recipes,
      entry: "web",
      invocation: [],
      handlers,
      read,
    });
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    const plan = prepared.plan!;
    assert.equal(plan.requiresReplan, true);
    assert.equal(plan.operations.length, 1);
    assert.equal(plan.operations[0]!.kind, "command");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("the experiment recipes combine before meeting generated state", async () => {
  const recipes = shadcnExperimentRecipes("node", ["--version"], "/tmp/workspace");
  const resolved = resolveRecipes(recipes, "web", [], handlers);
  assert.deepEqual(resolved.conflicts, [], resolved.conflicts.join("\n"));
  const manifest = resolved.artifacts.find((artifact) => artifact.path === "package.json")!;
  // SAFETY: the combined contribution carries the maps both recipes wrote above.
  const combined = JSON.parse(manifest.contents) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.deepEqual(combined.devDependencies, { vitest: "^3.2.4" });
  assert.deepEqual(combined.dependencies, { clsx: "^2.1.1" });
  assert.deepEqual(combined.scripts, { test: "vitest run" });
  const config = resolved.artifacts.find((artifact) => artifact.path === ".oxlintrc.jsonc")!;
  assert.deepEqual(JSON.parse(config.contents), { rules: { "no-debugger": "error" } });
});

test("settled generated state plans no preparation command", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tamo-shadcn-gate-"));
  try {
    const project = join(workspace, SHADCN_PROJECT);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "components.json"), "{}");
    const recipes = shadcnExperimentRecipes("node", ["--version"], workspace);
    const prepared = await planComposition({
      cwd: project,
      recipes,
      entry: "web",
      invocation: [],
      handlers,
      read,
    });
    assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
    assert.equal(prepared.plan!.requiresReplan, false);
    assert.deepEqual(
      prepared.plan!.operations.filter((operation) => operation.kind === "command"),
      [],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
