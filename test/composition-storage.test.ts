import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planComposition, resolveRecipes, type Recipe } from "../src/compose.ts";
import { oxlintConfigHandler } from "../src/handlers/oxlint-config.ts";
import { packageManifestHandler } from "../src/handlers/package-manifest.ts";
import { loadAllRecipes, saveRecipe } from "../src/recipes.ts";
import { read } from "../src/runtime.ts";
import { planCreate } from "../src/create.ts";

const root = resolve(".");
const handlers = [packageManifestHandler, oxlintConfigHandler];

const effectConfig = (rules: Record<string, string>) =>
  JSON.stringify({ plugins: ["effecttsgo"], rules });

const baseConfig = effectConfig({ "a-rule": "error", "b-rule": "error", "c-rule": "error" });
const webManifest = JSON.stringify({ devDependencies: { "d-pkg": "1.0.0" } });

// The motivating case, on disk: effect carries A/B/C as Oxlint rules, web
// includes effect, omits B, and contributes D through its own package.json.
// Disjoint artifact paths compose through the one Core path; overlapping
// sibling composition is out of scope.
async function seedComposition(home: string): Promise<void> {
  await saveRecipe(home, "effect", [{ path: ".oxlintrc.jsonc", contents: baseConfig }]);
  const webDir = join(home, "recipes", "web");
  await mkdir(join(webDir, "artifacts"), { recursive: true });
  await writeFile(
    join(webDir, "recipe.json"),
    JSON.stringify(
      {
        includes: [{ recipe: "effect" }],
        customizations: [
          {
            op: "omit",
            instance: ["effect"],
            artifact: ".oxlintrc.jsonc",
            selector: "rules",
            entry: "b-rule",
          },
        ],
      },
      null,
      2,
    ),
  );
  await writeFile(join(webDir, "artifacts", "package.json"), webManifest);
}

function rulesOf(contents: string): Record<string, string> {
  // SAFETY: fixtures always write a { rules } object; JSON.parse returns unknown.
  return (JSON.parse(contents) as { rules: Record<string, string> }).rules;
}

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "tamo-composition-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("durable re-resolution follows child changes without snapshotting", async () => {
  await withTempHome(async (home) => {
    await seedComposition(home);
    const first = await loadAllRecipes(home);
    assert.deepEqual(first.conflicts, []);
    const resolved = resolveRecipes(first.recipes, "web", [], handlers);
    assert.deepEqual(resolved.conflicts, []);
    const config = resolved.artifacts.find((artifact) => artifact.path === ".oxlintrc.jsonc")!;
    assert.deepEqual(Object.keys(rulesOf(config.contents)).sort(), ["a-rule", "c-rule"]);
    assert.deepEqual(config.instance, ["web", "effect"]);
    const manifest = resolved.artifacts.find((artifact) => artifact.path === "package.json")!;
    assert.deepEqual(JSON.parse(manifest.contents), JSON.parse(webManifest));
    assert.deepEqual(manifest.instance, ["web"]);

    // Mutate only the child on disk, then reload without touching web.
    await writeFile(
      join(home, "recipes", "effect", "artifacts", ".oxlintrc.jsonc"),
      effectConfig({ "a-rule": "error", "b-rule": "error", "c-rule": "error", "e-rule": "error" }),
    );
    const second = await loadAllRecipes(home);
    assert.deepEqual(second.conflicts, []);
    const reResolved = resolveRecipes(second.recipes, "web", [], handlers);
    assert.deepEqual(reResolved.conflicts, []);
    const updated = reResolved.artifacts.find((artifact) => artifact.path === ".oxlintrc.jsonc")!;
    assert.deepEqual(Object.keys(rulesOf(updated.contents)).sort(), ["a-rule", "c-rule", "e-rule"]);
    const kept = reResolved.artifacts.find((artifact) => artifact.path === "package.json")!;
    assert.deepEqual(JSON.parse(kept.contents), JSON.parse(webManifest));
  });
});

test("durable-loaded resolution equals in-memory resolution", async () => {
  await withTempHome(async (home) => {
    await seedComposition(home);
    const loaded = await loadAllRecipes(home);
    assert.deepEqual(loaded.conflicts, []);
    const fromDisk = resolveRecipes(loaded.recipes, "web", [], handlers);

    const memory: Record<string, Recipe> = {
      effect: { name: "effect", artifacts: [{ path: ".oxlintrc.jsonc", contents: baseConfig }] },
      web: {
        name: "web",
        artifacts: [{ path: "package.json", contents: webManifest }],
        includes: [{ recipe: "effect" }],
        customizations: [
          {
            op: "omit",
            instance: ["effect"],
            artifact: ".oxlintrc.jsonc",
            selector: "rules",
            entry: "b-rule",
          },
        ],
      },
    };
    const fromMemory = resolveRecipes(memory, "web", [], handlers);
    assert.deepEqual(fromMemory.conflicts, []);
    assert.deepEqual(fromDisk, fromMemory);
  });
});

test("removing an omitted child entry surfaces a stale customization error", async () => {
  await withTempHome(async (home) => {
    await seedComposition(home);
    await writeFile(
      join(home, "recipes", "effect", "artifacts", ".oxlintrc.jsonc"),
      effectConfig({ "a-rule": "error", "c-rule": "error" }),
    );
    const loaded = await loadAllRecipes(home);
    assert.deepEqual(loaded.conflicts, []);
    const resolved = resolveRecipes(loaded.recipes, "web", [], handlers);
    assert.ok(
      resolved.conflicts.some(
        (conflict) => conflict.includes("b-rule") && conflict.includes("[web > effect]"),
      ),
      resolved.conflicts.join("\n"),
    );
  });
});

test("deleting an included child names the includer", async () => {
  await withTempHome(async (home) => {
    await seedComposition(home);
    await rm(join(home, "recipes", "effect"), { recursive: true, force: true });
    const loaded = await loadAllRecipes(home);
    assert.deepEqual(loaded.conflicts, []);
    const resolved = resolveRecipes(loaded.recipes, "web", [], handlers);
    assert.ok(
      resolved.conflicts.some(
        (conflict) => conflict.includes("Unknown recipe: effect") && conflict.includes("web"),
      ),
      resolved.conflicts.join("\n"),
    );
  });
});

test("a cycle between durable recipes conflicts visibly", async () => {
  await withTempHome(async (home) => {
    await seedComposition(home);
    await writeFile(
      join(home, "recipes", "effect", "recipe.json"),
      JSON.stringify({ includes: [{ recipe: "web" }] }),
    );
    const loaded = await loadAllRecipes(home);
    assert.deepEqual(loaded.conflicts, []);
    const resolved = resolveRecipes(loaded.recipes, "web", [], handlers);
    assert.ok(
      resolved.conflicts.some((conflict) => conflict.includes("cycle")),
      resolved.conflicts.join("\n"),
    );
  });
});

test("temporary invocation customization leaves recipe files byte-for-byte unchanged", async () => {
  await withTempHome(async (home) => {
    await seedComposition(home);
    const target = await mkdtemp(join(tmpdir(), "tamo-composition-target-"));
    try {
      const before = await readFile(join(home, "recipes", "web", "recipe.json"), "utf8");
      const loaded = await loadAllRecipes(home);
      assert.deepEqual(loaded.conflicts, []);
      const prepared = await planComposition({
        cwd: target,
        recipes: loaded.recipes,
        entry: "web",
        invocation: [
          {
            op: "omit",
            instance: ["web", "effect"],
            artifact: ".oxlintrc.jsonc",
            selector: "rules",
            entry: "a-rule",
          },
        ],
        handlers,
        read,
      });
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      const config = prepared.artifacts.find((artifact) => artifact.path === ".oxlintrc.jsonc")!;
      assert.deepEqual(Object.keys(rulesOf(config.contents)).sort(), ["c-rule"]);
      assert.equal(await readFile(join(home, "recipes", "web", "recipe.json"), "utf8"), before);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

test("durable recipe.json rejects unknown keys, bad includes, and non-omit ops", async () => {
  await withTempHome(async (home) => {
    await saveRecipe(home, "effect", [{ path: ".oxlintrc.jsonc", contents: baseConfig }]);
    const webDir = join(home, "recipes", "web");
    await mkdir(join(webDir, "artifacts"), { recursive: true });
    await writeFile(join(webDir, "artifacts", "package.json"), webManifest);
    const cases: Array<[string, RegExp]> = [
      [`{"includes":[{"recipe":"effect","as":"e"}]}`, /exactly \{ "recipe": name \}/],
      [
        `{"customizations":[{"op":"omit","instance":[],"artifact":"package.json","selector":"dependencies","entry":"x"}]}`,
        /non-empty string array/,
      ],
      [
        `{"customizations":[{"op":"put","instance":["effect"],"artifact":"package.json","selector":"dependencies","entry":"x"}]}`,
        /only "omit" is supported/,
      ],
      [`{"future":true}`, /Unknown recipe key/],
    ];
    for (const [body, pattern] of cases) {
      await writeFile(join(webDir, "recipe.json"), body);
      const loaded = await loadAllRecipes(home);
      assert.ok(
        loaded.conflicts.some((conflict) => pattern.test(conflict)),
        `${body}: ${loaded.conflicts.join("\n")}`,
      );
    }
  });
});

test("merge coverage blocks silently-dropped package.json fields, not identical ones", async () => {
  await withTempHome(async (home) => {
    await saveRecipe(home, "effect", [{ path: ".oxlintrc.jsonc", contents: baseConfig }]);
    const target = await mkdtemp(join(tmpdir(), "tamo-composition-target-"));
    try {
      const recipeWith = async (
        manifest: Record<string, unknown>,
        targetManifest: string | null,
      ) => {
        if (targetManifest === null) await rm(join(target, "package.json"), { force: true });
        else await writeFile(join(target, "package.json"), targetManifest);
        const webDir = join(home, "recipes", "web");
        await mkdir(join(webDir, "artifacts"), { recursive: true });
        await writeFile(join(webDir, "recipe.json"), "{}");
        await writeFile(join(webDir, "artifacts", "package.json"), JSON.stringify(manifest));
        const loaded = await loadAllRecipes(home);
        assert.deepEqual(loaded.conflicts, []);
        return planComposition({
          cwd: target,
          recipes: loaded.recipes,
          entry: "web",
          invocation: [],
          handlers,
          read,
        });
      };
      // A contributed field the merge cannot honor blocks loudly.
      const blocked = await recipeWith(
        { devDependencies: { "d-pkg": "1.0.0" }, engines: { node: ">=20" } },
        `{"name":"t"}`,
      );
      assert.equal(blocked.plan, undefined);
      assert.ok(
        blocked.conflicts.some((conflict) => conflict.includes("engines")),
        blocked.conflicts.join("\n"),
      );
      // The identical value already in the target needs no application.
      const matched = await recipeWith(
        { devDependencies: { "d-pkg": "1.0.0" }, engines: { node: ">=20" } },
        `{"name":"t","engines":{"node":">=20"}}`,
      );
      assert.deepEqual(matched.conflicts, [], matched.conflicts.join("\n"));
      // Absent targets still materialize complete bytes, extra fields included.
      const created = await recipeWith(
        { devDependencies: { "d-pkg": "1.0.0" }, engines: { node: ">=20" } },
        null,
      );
      assert.deepEqual(created.conflicts, [], created.conflicts.join("\n"));
      const write = created.plan!.operations.find(
        (operation) => operation.kind === "write" && operation.path.endsWith("package.json"),
      );
      if (!write || write.kind !== "write") assert.fail("expected a package.json write");
      assert.deepEqual(JSON.parse(write.after).engines, { node: ">=20" });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

test("merge coverage blocks silently-dropped oxlint fields", async () => {
  await withTempHome(async (home) => {
    const target = await mkdtemp(join(tmpdir(), "tamo-composition-target-"));
    try {
      await writeFile(join(target, ".oxlintrc.jsonc"), `{"rules":{}}`);
      const webDir = join(home, "recipes", "web");
      await mkdir(join(webDir, "artifacts"), { recursive: true });
      await writeFile(join(webDir, "recipe.json"), "{}");
      await writeFile(
        join(webDir, "artifacts", ".oxlintrc.jsonc"),
        JSON.stringify({ rules: { "a-rule": "error" }, futureField: { nested: true } }),
      );
      const loaded = await loadAllRecipes(home);
      assert.deepEqual(loaded.conflicts, []);
      const prepared = await planComposition({
        cwd: target,
        recipes: loaded.recipes,
        entry: "web",
        invocation: [],
        handlers,
        read,
      });
      assert.ok(
        prepared.conflicts.some((conflict) => conflict.includes("futureField")),
        prepared.conflicts.join("\n"),
      );
      assert.deepEqual(
        prepared.plan?.operations ?? [],
        [],
        "blocked plans propose zero operations",
      );
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

function runCli(args: string[], home: string) {
  const result = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, TAMO_HOME: home },
    encoding: "utf8",
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("tamo add resolves durable home recipes through the Core path", async () => {
  await withTempHome(async (home) => {
    await seedComposition(home);
    const target = await mkdtemp(join(tmpdir(), "tamo-composition-target-"));
    try {
      await writeFile(join(target, "package.json"), `{"name":"t","packageManager":"pnpm@1"}`);
      await writeFile(join(target, ".oxlintrc.jsonc"), `{"rules":{}}`);
      const dry = runCli(["add", "web", "--cwd", target, "--json", "--dry-run"], home);
      assert.equal(dry.code, 0, dry.stderr);
      const preview = JSON.parse(dry.stdout);
      assert.equal(preview.plan.subject, "recipe:web");
      assert.deepEqual(preview.plan.conflicts, []);
      const config = preview.plan.operations.find((operation: { path: string }) =>
        operation.path.endsWith(".oxlintrc.jsonc"),
      );
      assert.deepEqual(Object.keys(JSON.parse(config.after).rules).sort(), ["a-rule", "c-rule"]);
      const manifest = preview.plan.operations.find((operation: { path: string }) =>
        operation.path.endsWith("package.json"),
      );
      assert.deepEqual(JSON.parse(manifest.after).devDependencies, { "d-pkg": "1.0.0" });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

test("a durable recipe named effect-oxlint resolves as an ordinary recipe", async () => {
  await withTempHome(async (home) => {
    await saveRecipe(home, "effect-oxlint", [{ path: "notes.md", contents: "ordinary\n" }]);
    const target = await mkdtemp(join(tmpdir(), "tamo-composition-target-"));
    try {
      await writeFile(join(target, "package.json"), `{"name":"t","packageManager":"pnpm@1"}`);
      // No reserved-name failure: effect-oxlint is durable state like any
      // other recipe, planned through the one Core path.
      const dry = runCli(["add", "effect-oxlint", "--cwd", target, "--json", "--dry-run"], home);
      assert.equal(dry.code, 0, dry.stdout);
      const preview = JSON.parse(dry.stdout);
      assert.equal(preview.plan.subject, "recipe:effect-oxlint");
      assert.deepEqual(preview.plan.conflicts, []);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

test("create through an including recipe stamps the target name", async () => {
  await withTempHome(async (home) => {
    await seedComposition(home);
    const workspace = await mkdtemp(join(tmpdir(), "tamo-composition-ws-"));
    try {
      const prepared = await planCreate(home, workspace, "app", "web");
      assert.deepEqual(prepared.conflicts, [], prepared.conflicts.join("\n"));
      const write = prepared.plan!.operations.find(
        (operation) => operation.kind === "write" && operation.path.endsWith("package.json"),
      );
      if (!write || write.kind !== "write") assert.fail("expected a package.json write");
      assert.equal(JSON.parse(write.after).name, "app");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

test("differing version and packageManager cannot be silently ignored", async () => {
  await withTempHome(async (home) => {
    const target = await mkdtemp(join(tmpdir(), "tamo-composition-target-"));
    try {
      const webDir = join(home, "recipes", "web");
      await mkdir(join(webDir, "artifacts"), { recursive: true });
      await writeFile(join(webDir, "recipe.json"), "{}");
      const planAgainst = async (contribution: string, targetManifest: string) => {
        await writeFile(join(target, "package.json"), targetManifest);
        await writeFile(join(webDir, "artifacts", "package.json"), contribution);
        const loaded = await loadAllRecipes(home);
        assert.deepEqual(loaded.conflicts, []);
        return planComposition({
          cwd: target,
          recipes: loaded.recipes,
          entry: "web",
          invocation: [],
          handlers,
          read,
        });
      };
      const base = { dependencies: { "d-pkg": "1.0.0" } };
      // Differing values block instead of upgrading or switching toolchains.
      const pmConflict = await planAgainst(
        JSON.stringify({ ...base, packageManager: "pnpm@10.11.0" }),
        `{"name":"t","packageManager":"npm@9.0.0"}`,
      );
      assert.equal(pmConflict.plan, undefined);
      assert.ok(
        pmConflict.conflicts.some((conflict) => conflict.includes("packageManager")),
        pmConflict.conflicts.join("\n"),
      );
      const versionConflict = await planAgainst(
        JSON.stringify({ ...base, version: "2.0.0" }),
        `{"name":"t","version":"1.0.0"}`,
      );
      assert.equal(versionConflict.plan, undefined);
      assert.ok(
        versionConflict.conflicts.some((conflict) => conflict.includes("version")),
        versionConflict.conflicts.join("\n"),
      );
      // Missing target values are set plainly with a disclosed write.
      const applied = await planAgainst(
        JSON.stringify({ ...base, version: "1.0.0", packageManager: "pnpm@10.11.0" }),
        `{"name":"t"}`,
      );
      assert.deepEqual(applied.conflicts, [], applied.conflicts.join("\n"));
      const write = applied.plan!.operations.find(
        (operation) => operation.kind === "write" && operation.path.endsWith("package.json"),
      );
      if (!write || write.kind !== "write") assert.fail("expected a package.json write");
      assert.deepEqual(JSON.parse(write.after).version, "1.0.0");
      assert.deepEqual(JSON.parse(write.after).packageManager, "pnpm@10.11.0");
      // Identical values need no application and stay quiet.
      const matched = await planAgainst(
        JSON.stringify({ version: "1.0.0", packageManager: "pnpm@10.11.0" }),
        `{"name":"t","version":"1.0.0","packageManager":"pnpm@10.11.0"}`,
      );
      assert.deepEqual(matched.conflicts, [], matched.conflicts.join("\n"));
      assert.deepEqual(matched.plan!.operations, []);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

test("nested rule config cannot disappear silently during existing-target merge", async () => {
  await withTempHome(async (home) => {
    const target = await mkdtemp(join(tmpdir(), "tamo-composition-target-"));
    try {
      const webDir = join(home, "recipes", "web");
      await mkdir(join(webDir, "artifacts"), { recursive: true });
      await writeFile(join(webDir, "recipe.json"), "{}");
      const planAgainst = async (contribution: string, targetConfig: string | null) => {
        if (targetConfig === null) await rm(join(target, ".oxlintrc.jsonc"), { force: true });
        else await writeFile(join(target, ".oxlintrc.jsonc"), targetConfig);
        await writeFile(join(webDir, "artifacts", ".oxlintrc.jsonc"), contribution);
        const loaded = await loadAllRecipes(home);
        assert.deepEqual(loaded.conflicts, []);
        return planComposition({
          cwd: target,
          recipes: loaded.recipes,
          entry: "web",
          invocation: [],
          handlers,
          read,
        });
      };
      const nested = JSON.stringify({ rules: { "a-rule": ["error", { strict: true }] } });
      // A missing target rule is added with its full nested bytes intact.
      const added = await planAgainst(nested, `{"rules":{}}`);
      assert.deepEqual(added.conflicts, [], added.conflicts.join("\n"));
      const add = added.plan!.operations.find(
        (operation) => operation.kind === "write" && operation.path.endsWith(".oxlintrc.jsonc"),
      );
      if (!add || add.kind !== "write") assert.fail("expected a config write");
      assert.deepEqual(JSON.parse(add.after).rules["a-rule"], ["error", { strict: true }]);
      // A severity-only target value is a real divergence, not a match.
      const diverged = await planAgainst(nested, `{"rules":{"a-rule":"error"}}`);
      assert.equal(diverged.plan, undefined);
      assert.ok(
        diverged.conflicts.some((conflict) => conflict.includes("a-rule")),
        diverged.conflicts.join("\n"),
      );
      // The identical nested value already in place needs no application.
      const matched = await planAgainst(nested, nested);
      assert.deepEqual(matched.conflicts, [], matched.conflicts.join("\n"));
      assert.deepEqual(matched.plan!.operations, []);
      // Absent targets still materialize the complete nested bytes verbatim.
      const created = await planAgainst(nested, null);
      assert.deepEqual(created.conflicts, [], created.conflicts.join("\n"));
      const write = created.plan!.operations.find(
        (operation) => operation.kind === "write" && operation.path.endsWith(".oxlintrc.jsonc"),
      );
      if (!write || write.kind !== "write") assert.fail("expected a config write");
      assert.deepEqual(JSON.parse(write.after), JSON.parse(nested));
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
