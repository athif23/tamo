import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

// Canonical effect-oxlint procedural behavior. This file is the single
// implementation: durable recipes carry it as behavior.mjs, and tests seed
// installed recipes by copying this directory as a unit. It imports nothing
// from the Tamo checkout — only node: builtins plus the public Behavior
// context (cwd, instance, artifacts, read, track) — so an installed recipe
// keeps working if the source-tree layout changes. The small generic helpers
// below (JSONC reading, severity, inherited-config walk, command runner) are
// intentionally local rather than imported: planning observations still go
// through context.read/track, so reviewed-input rechecking is unchanged.
//
// The behavior never writes artifacts the recipe represents: finalize
// contributes commands only; the plugin file and persistent config arrive
// through the handlers and Core's whole-file fallback.

export const versions = {
  effect: "4.0.0-rc.112",
  oxlint: "1.80.0",
  "@effect/tsgo": "0.38.0",
  "oxlint-tsgolint": "7.0.2001",
  "@oxlint/plugins": "1.80.0",
};

// Environment preconditions of this setup, not recipe contributions: Effect
// and Oxlint must already be declared and installed by the target project.
// Desired versions of contributed dependencies live in the recipe's
// package.json artifact; nothing here duplicates them.
const preconditions = { effect: versions.effect, oxlint: versions.oxlint };

// Rules the @effect/tsgo correctness preset enables upstream. This is
// knowledge about the preset's contents, used only for read-only conflict
// checking; the recipe never writes these rules explicitly.
const presetRules = [
  "any-unknown-in-error-context",
  "class-self-mismatch",
  "duplicate-package",
  "effect-fn-implicit-any",
  "floating-effect",
  "floating-effect-in-vitest",
  "generic-effect-services",
  "missing-effect-context",
  "missing-effect-error",
  "missing-layer-context",
  "missing-return-yield-star",
  "missing-star-in-yield-effect-gen",
  "non-object-effect-service-type",
  "outdated-api",
  "overridden-schema-constructor",
  "promise-in-effect-success",
  "schema-literal-non-finite",
  "schema-opaque-instance-member",
];

const correctnessPreset = "./node_modules/@effect/tsgo/oxlint-presets/correctness.json";

// ---- minimal JSONC reading (local so this module stays checkout-independent) ----

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Strip // line comments and /* block */ comments outside double-quoted
// strings, then drop trailing commas outside strings. This covers the JSONC
// subset recipe and target configs use (comments, trailing commas); anything
// else fails loudly in JSON.parse below, matching the strict-decode contract.
function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  let clean = "";
  i = 0;
  inStr = false;
  escaped = false;
  while (i < out.length) {
    const ch = out[i];
    if (inStr) {
      clean += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      clean += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") {
        i++;
        continue;
      }
    }
    clean += ch;
    i++;
  }
  return clean;
}

function parseObject(text, path) {
  let value;
  try {
    value = JSON.parse(stripJsonc(text));
  } catch {
    throw new Error(`Expected a valid JSON/JSONC object: ${path}`);
  }
  if (!isObject(value)) throw new Error(`Expected a valid JSON/JSONC object: ${path}`);
  return value;
}

function arrayOf(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected an array: ${field}`);
  return value;
}

function severity(value) {
  if (Array.isArray(value)) return value.length === 1 ? severity(value[0]) : value;
  return value === 2
    ? "error"
    : value === 1
      ? "warn"
      : value === 0 || value === "allow"
        ? "off"
        : value;
}

// ---- verification expectations (derived from resolved intent) ----

// Which diagnostics the behavioral probe must demonstrate, derived from the
// resolved (customized) config artifact — not from the recipe's normal
// state — so intentional customization (e.g. omitting a rule from the
// contribution) changes verification expectations instead of failing them.
// Expectations are positive-only: a diagnostic firing that the resolved
// intent did not require is the target's own state, never a failure.
export function probeExpectations(config) {
  const rules = isObject(config.rules) ? config.rules : {};
  const jsPlugins = Array.isArray(config.jsPlugins) ? config.jsPlugins : [];
  const registersTamoEffect = jsPlugins.some(
    (entry) => isObject(entry) && entry.name === "tamo-effect",
  );
  const extendsCorrectness =
    Array.isArray(config.extends) && config.extends.includes(correctnessPreset);
  const enabled = (rule) => {
    const value = rules[rule];
    return value !== undefined && JSON.stringify(severity(value)) !== '"off"';
  };

  const ordinary = [];
  const test = [];
  if (extendsCorrectness) {
    ordinary.push("effecttsgo(floating-effect)");
    test.push("effecttsgo(floating-effect)");
  }
  if (enabled("tamo-effect/no-layer-in-service-class") && registersTamoEffect) {
    ordinary.push("tamo-effect(no-layer-in-service-class)");
    test.push("tamo-effect(no-layer-in-service-class)");
  }
  if (enabled("effecttsgo/strict-effect-provide")) {
    ordinary.push("effecttsgo(strict-effect-provide)");
    // The contributed test exception turns the rule off for test files.
    const overridden = Array.isArray(config.overrides)
      ? config.overrides.some(
          (override) =>
            isObject(override) &&
            isObject(override.rules) &&
            override.files !== undefined &&
            Array.isArray(override.files) &&
            override.files.includes("**/test/**") &&
            override.files.includes("scripts/**") &&
            JSON.stringify(severity(override.rules["effecttsgo/strict-effect-provide"])) ===
              '"off"',
        )
      : false;
    if (!overridden) test.push("effecttsgo(strict-effect-provide)");
  }
  return { ordinary, test };
}

function artifactNamed(context, path) {
  return context.artifacts.find((artifact) => artifact.path === path).contents;
}

// Desired versions of the setup's contributed dependencies, read from the
// recipe's own package.json artifact (resolved, customized state).
function recipeDevDependencies(contents) {
  const desired = parseObject(contents, "recipe package.json").devDependencies;
  if (!isObject(desired ?? {}))
    throw new Error("Recipe package.json must carry a devDependencies map.");
  return Object.fromEntries(
    Object.entries(desired).map(([name, version]) => {
      if (typeof version !== "string") throw new Error(`Invalid recipe dependency: ${name}`);
      return [name, version];
    }),
  );
}

// The recipe's extends entries at its config root; the preset-rule check
// skips them when walking the target's inherited chain.
function recipeExtends(contents) {
  const value = parseObject(contents, "recipe .oxlintrc.json").extends;
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

async function rejectUnsupportedLayout(read, cwd, conflicts) {
  for (let parent = dirname(cwd); ; parent = dirname(parent)) {
    if (parent !== cwd && (await read(join(parent, "pnpm-workspace.yaml"))) !== null)
      conflicts.push(
        "Target belongs to a parent pnpm workspace; workspace installation is outside this setup's scope.",
      );
    if (parent === dirname(parent)) break;
  }
  for (const marker of [
    "pnpm-workspace.yaml",
    "oxlint.config.ts",
    "oxlint.config.mts",
    "oxlint.config.js",
  ])
    if ((await read(marker)) !== null) conflicts.push(`Unsupported: ${marker}`);
}

async function inspectManifest(read, conflicts, evidence, recipeManifestText) {
  const manifestText = await read("package.json");
  // Finalize hooks run while the final Plan is being constructed, so
  // same-Plan artifact writes do not exist on disk yet. When the target
  // has no manifest but the recipe contributes one (the create case),
  // reason from the resolved recipe intent instead of failing on the
  // absent file. Genuine gaps (missing packageManager, unsatisfied
  // preconditions) still conflict below — nothing is weakened.
  if (manifestText === null) {
    if (recipeManifestText === null) throw new Error("Target must contain package.json.");
    evidence.push("target package.json absent; reasoning from recipe intent");
    const fallback = parseObject(recipeManifestText, "recipe package.json");
    if (fallback.workspaces !== undefined) conflicts.push("Workspace manifests are unsupported.");
    if (typeof fallback.packageManager !== "string" || !/^pnpm@\d/.test(fallback.packageManager))
      conflicts.push("Target must declare a pnpm packageManager.");
    await read("pnpm-lock.yaml");
    return fallback;
  }
  const manifest = parseObject(manifestText, "package.json");
  if (manifest.workspaces !== undefined) conflicts.push("Workspace manifests are unsupported.");
  if (typeof manifest.packageManager !== "string" || !/^pnpm@\d/.test(manifest.packageManager))
    conflicts.push("Target must declare a pnpm packageManager.");
  await read("pnpm-lock.yaml");
  return manifest;
}

function declaredVersion(manifest, name) {
  for (const field of ["dependencies", "devDependencies"]) {
    const value = manifest[field];
    if (isObject(value) && name in value) return value[name];
  }
  return undefined;
}

// Check one dependency of this setup against the target's environment:
// preconditions must be declared and installed, installed versions must
// match, and uninstalled declared versions must not differ from the recipe.
async function checkOneDependency(read, manifest, name, version, conflicts, evidence) {
  const installed = await read(`node_modules/${name}/package.json`);
  const declared = declaredVersion(manifest, name);
  if (declared !== undefined && typeof declared !== "string")
    throw new Error(`Invalid dependency declaration: ${name}`);
  if (name in preconditions && (!declared || installed === null))
    conflicts.push(`${name} must already be declared and installed.`);
  if (installed === null) {
    if (declared && declared !== version)
      conflicts.push(`Cannot establish compatibility for uninstalled ${name} (${declared}).`);
    return "missing";
  }
  const actual = parseObject(installed, name).version;
  if (typeof actual !== "string") throw new Error(`Invalid installed package version: ${name}`);
  if (actual !== version) {
    conflicts.push(`${name}: expected ${version}, found ${actual}. No automatic upgrade.`);
    return "installed";
  }
  evidence.push(`${name} ${version} installed`);
  return "installed";
}

// Desired dependency versions come from the recipe's package.json artifact;
// this check only compares the installed environment against them.
async function checkDependencies(read, manifest, desired, conflicts, evidence) {
  let needsInstall = false;
  let allInstalled = true;
  for (const [name, version] of [...Object.entries(preconditions), ...Object.entries(desired)]) {
    const outcome = await checkOneDependency(read, manifest, name, version, conflicts, evidence);
    if (outcome === "missing") {
      needsInstall = true;
      allInstalled = false;
    }
  }
  return { needsInstall, allInstalled };
}

function resolveInheritedEntry(cwd, entry, parent) {
  if (typeof entry !== "string" || !entry.startsWith("."))
    throw new Error("Only relative JSON/JSONC extends are supported.");
  const path = resolve(dirname(parent), entry);
  const rel = relative(cwd, path);
  if (
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    !/\.jsonc?$/.test(path) ||
    rel.split(/[\\/]/).includes("node_modules")
  )
    throw new Error(`Unsupported inherited configuration: ${entry}`);
  return { path, name: entry };
}

// Walk the target's extends chain within a bounded arrangement: relative
// JSON/JSONC inside the project, no cycles, no config-changing inherited
// entries. Entries the contribution itself adds at the root are skipped.
// Reads go through the tracked read, so inherited files participate in the
// input recheck.
async function collectInheritedConfigs(cwd, configName, config, read, skipAtRoot) {
  const inherited = [];
  const visited = new Set();
  const walk = async (value, parent, isRoot) => {
    for (const entry of arrayOf(value.extends, "extends")) {
      if (isRoot && typeof entry === "string" && skipAtRoot.includes(entry)) continue;
      const { path, name } = resolveInheritedEntry(cwd, entry, parent);
      if (visited.has(path))
        throw new Error("Repeated/cyclic inherited configuration is unsupported.");
      visited.add(path);
      const text = await read(path);
      if (text === null) throw new Error(`Missing inherited config: ${name}`);
      const parsed = parseObject(text, path);
      if (
        parsed.plugins !== undefined ||
        parsed.jsPlugins !== undefined ||
        parsed.options !== undefined ||
        parsed.overrides !== undefined
      )
        throw new Error(
          `Inherited plugin/options/override configuration requires manual review: ${name}`,
        );
      inherited.push({ name, path, config: parsed });
      await walk(parsed, path, false);
    }
  };
  await walk(config, join(cwd, configName), true);
  return { inherited };
}

// Read-only check across the target root and its bounded inherited chain:
// rules the upstream correctness preset enables must not be explicitly
// disabled or re-leveled by the target's own configuration. Reads go through
// the tracked read, so inherited files participate in the input recheck.
async function checkPresetRules(read, cwd, skipAtRoot, conflicts, evidence, recipeProvidesConfig) {
  const configName = (await read(".oxlintrc.json")) !== null ? ".oxlintrc.json" : ".oxlintrc.jsonc";
  const targetText = await read(configName);
  // Same finalize-planning rule as the manifest: no target config yet but
  // the recipe contributes one means there is no existing target
  // configuration to conflict — the recipe intent is known good, and the
  // handlers will materialize it. Skip rather than fail.
  if (targetText === null) {
    if (recipeProvidesConfig) {
      evidence.push("target Oxlint config absent; recipe intent provides it");
      return;
    }
    throw new Error("Expected an Oxlint config in the target.");
  }
  const target = parseObject(targetText, configName);
  const walk = await collectInheritedConfigs(cwd, configName, target, read, skipAtRoot);
  for (const { name, config } of [{ name: configName, config: target }, ...walk.inherited]) {
    const rules = config.rules;
    if (rules === undefined) continue;
    if (!isObject(rules)) throw new Error(`Expected an object: ${name}.rules`);
    for (const rule of presetRules) {
      // The correctness preset enables these rules through the effecttsgo
      // plugin; explicit target entries carry that prefix.
      const setting = rules[`effecttsgo/${rule}`];
      if (setting !== undefined && JSON.stringify(severity(setting)) !== '"warn"')
        conflicts.push(`${name}: preset rule ${rule} is explicitly reconfigured.`);
    }
  }
}

// ---- patch-state detection ----

// Match the two packaged native artifacts, not a Tamo-owned installation
// marker. The expected replacement artifacts are keyed by the versions this
// setup supports (SPEC Slice 1 baseline). Every observed file is registered
// through `track` so the reviewed-input recheck covers it.
async function patched(cwd, oxlintVersion, tsgolintVersion, track) {
  const req = createRequire(join(cwd, "package.json"));
  const platform = `${process.platform}-${process.arch}`;
  const suffix =
    process.platform === "win32" ? "-msvc" : process.platform === "linux" ? "-gnu" : "";
  const tsgo = req.resolve("@effect/tsgo/package.json");
  const replacements = dirname(createRequire(tsgo).resolve(`@effect/tsgo-${platform}/package.json`));
  const ox = req.resolve("oxlint/package.json");
  const binding = createRequire(ox).resolve(`@oxlint/binding-${platform}${suffix}/package.json`);
  const bindingInfo = parseObject(await readFile(binding, "utf8"), binding);
  if (typeof bindingInfo.main !== "string")
    throw new Error("Oxlint native package has no main entry.");
  const tsg = createRequire(req.resolve("oxlint-tsgolint/package.json")).resolve(
    `@oxlint-tsgolint/${platform}/package.json`,
  );

  for (const [target, expected] of [
    [
      join(dirname(binding), bindingInfo.main),
      join(replacements, "artifacts", "oxlint", oxlintVersion, basename(bindingInfo.main)),
    ],
    [
      join(dirname(tsg), process.platform === "win32" ? "tsgolint.exe" : "tsgolint"),
      join(
        replacements,
        "artifacts",
        "oxlint-tsgolint",
        tsgolintVersion,
        process.platform === "win32" ? "tsgolint.exe" : "tsgolint",
      ),
    ],
  ]) {
    const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
    track(target, await readFile(target));
    track(expected, await readFile(expected));
    if ((await hash(target)) !== (await hash(expected))) return false;
  }
  const dts = join(dirname(ox), "dist/index.d.ts");
  const dtsContents = await readFile(dts, "utf8");
  track(dts, dtsContents);
  return dtsContents.includes('"effecttsgo"');
}

// ---- orchestration and verification (direct node: I/O so no checkout import is needed) ----

// The setup's commands, ordered after all artifact writes by Core: install
// with lifecycle scripts disabled (it must not edit package.json — the
// recipe owns that state), then the patch, which needs the installed
// packages. The patch-state check is skipped when the install alone already
// requires it.
async function planCommands(context, install, desiredVersions) {
  const operations = [];
  let patchNeeded = install.needsInstall || !install.allInstalled;
  if (!patchNeeded)
    patchNeeded = !(await patched(
      context.cwd,
      preconditions.oxlint,
      desiredVersions["oxlint-tsgolint"],
      context.track,
    ));

  if (install.needsInstall)
    operations.push({
      kind: "command",
      executable: "pnpm",
      args: ["install", "--ignore-scripts"],
      cwd: context.cwd,
      purpose:
        "Install declared dependencies and update pnpm-lock.yaml/node_modules (lifecycle scripts disabled)",
    });
  if (patchNeeded)
    operations.push({
      kind: "command",
      executable: "pnpm",
      args: ["exec", "effect-tsgo", "patch", "--no-typescript", "--oxlint"],
      cwd: context.cwd,
      purpose: "Patch installed Oxlint and its type-aware engine",
    });
  return operations;
}

async function readDirectNull(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
}

// Minimal pnpm-aware command runner matching the runtime's Windows handling:
// on Windows pnpm runs through its JS entry instead of a shell.
async function runCommand(executable, args, cwd) {
  let exec = executable;
  let finalArgs = args;
  if (executable === "pnpm" && process.platform === "win32") {
    const entry = process.env.npm_execpath;
    if (!entry || !/pnpm\.(?:c?js)$/i.test(entry))
      throw new Error("On Windows, launch Tamo with pnpm tamo so its pnpm executable is known.");
    exec = process.execPath;
    finalArgs = [entry, ...args];
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(exec, finalArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

export default {
  finalize: async (context) => {
    const conflicts = [];
    const evidence = [];
    const operations = [];
    try {
      await rejectUnsupportedLayout(context.read, context.cwd, conflicts);
      const recipeManifest = artifactNamed(context, "package.json");
      const manifest = await inspectManifest(context.read, conflicts, evidence, recipeManifest);
      const desiredVersions = recipeDevDependencies(recipeManifest);

      const install = await checkDependencies(
        context.read,
        manifest,
        desiredVersions,
        conflicts,
        evidence,
      );
      await checkPresetRules(
        context.read,
        context.cwd,
        recipeExtends(artifactNamed(context, ".oxlintrc.json")),
        conflicts,
        evidence,
        true,
      );
      if (conflicts.length) return { conflicts, evidence, operations };

      operations.push(...(await planCommands(context, install, desiredVersions)));
      return { conflicts, evidence, operations };
    } catch (error) {
      conflicts.push(error instanceof Error ? error.message : String(error));
      return { conflicts, evidence, operations: [] };
    }
  },

  // Post-application verification: replanning happens in Core; here the
  // setup demonstrates the rules the RESOLVED recipe intent requires on
  // isolated input. Expectations derive from the customized config artifact,
  // so intentional customization changes what verification demands instead
  // of failing it. Writes stay in the probe's own temporary directory,
  // removed afterwards.
  verify: async (context) => {
    const configArtifact = context.artifacts.find((artifact) => artifact.path === ".oxlintrc.json");
    if (!configArtifact)
      return ["Behavior verification found no Oxlint config artifact in the resolved recipe."];
    const expectations = probeExpectations(
      parseObject(configArtifact.contents, "resolved Oxlint config"),
    );
    const config =
      (await readDirectNull(join(context.cwd, ".oxlintrc.json"))) !== null
        ? ".oxlintrc.json"
        : ".oxlintrc.jsonc";

    const directory = await mkdtemp(join(context.cwd, ".tamo-validation-"));
    try {
      const source =
        'import { Context, Effect, Layer } from "effect";\nclass Probe extends Context.Service<Probe, {}>()("Probe") { static defaultLayer = Layer.empty; }\nEffect.gen(function* () { Effect.succeed(1); return 1; });\nexport const provided = Effect.void.pipe(Effect.provide(Layer.empty));\nexport { Probe };\n';

      await mkdir(join(directory, "test"), { recursive: true });
      await writeFile(join(directory, "probe.ts"), source);
      await writeFile(join(directory, "test", "probe.ts"), source);

      const lint = await runCommand(
        "pnpm",
        [
          "exec",
          "oxlint",
          "--config",
          config,
          "--disable-nested-config",
          "--format=json",
          join(directory, "probe.ts"),
          join(directory, "test", "probe.ts"),
        ],
        context.cwd,
      );
      if (!lint.stdout.trimStart().startsWith("{"))
        return [`Oxlint did not return JSON (${lint.code}).\n${lint.stdout}\n${lint.stderr}`];

      const output = parseObject(lint.stdout, "Oxlint JSON output");
      const diagnostics = output.diagnostics;
      if (!Array.isArray(diagnostics)) throw new Error("Expected an array: diagnostics");
      const has = (file, code) =>
        diagnostics.some(
          (value) =>
            isObject(value) &&
            typeof value.filename === "string" &&
            value.filename.replaceAll("\\", "/").endsWith(file) &&
            value.code === code,
        );
      const ordinary = `${basename(directory)}/probe.ts`;
      const testFile = `${basename(directory)}/test/probe.ts`;
      const missing = [
        ...expectations.ordinary.filter((code) => !has(ordinary, code)),
        ...expectations.test.filter((code) => !has(testFile, code)),
      ];
      if (expectations.ordinary.length && lint.code !== 1) missing.push(`lint exit ${lint.code}`);
      return missing.length
        ? [
            `Controlled lint probe did not demonstrate the resolved Effect setup; missing: ${missing.join(", ")}.\n${lint.stdout}\n${lint.stderr}`,
          ]
        : [];
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};
