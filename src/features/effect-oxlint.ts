import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve, relative, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, modify, applyEdits, type ParseError } from "jsonc-parser";
import type { Extension, Plan, ReadContext } from "../plan.ts";
import { fingerprint } from "../plan.ts";
import { command, read, withTempDirectory, write } from "../runtime.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectJson = { [key: string]: Json };
export const versions: Record<string, string> = {
  effect: "4.0.0-rc.112",
  oxlint: "1.80.0",
  "@effect/tsgo": "0.38.0",
  "oxlint-tsgolint": "7.0.2001",
  "@oxlint/plugins": "1.80.0",
};
export const rules = [
  "strict-effect-provide",
  "run-effect-inside-effect",
  "try-catch-in-effect-gen",
  "multiple-effect-provide",
  "scope-in-layer-effect",
  "layer-merge-all-with-dependencies",
  "leaking-requirements",
];
// The correctness preset shipped by the supported @effect/tsgo 0.38.0 release.
const correctnessRules = [
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
const preset = "./node_modules/@effect/tsgo/oxlint-presets/correctness.json";
const plugin = ".config/oxlint/tamo-effect.ts";
const patch = "effect-tsgo patch --no-typescript --oxlint";
const resource = fileURLToPath(new URL("./effect-oxlint/plugin.ts", import.meta.url));
const desiredRules: Record<string, string> = Object.fromEntries([
  ...rules.map((rule) => [`effecttsgo/${rule}`, "error"]),
  ["tamo-effect/no-layer-in-service-class", "error"],
]);
const requiredRules: Record<string, string> = {
  ...Object.fromEntries(correctnessRules.map((rule) => [`effecttsgo/${rule}`, "warn"])),
  ...desiredRules,
};
function object(value: unknown): value is ObjectJson {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function json(text: string, path: string): ObjectJson {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !object(value))
    throw new Error(`Expected a valid JSON/JSONC object: ${path}`);
  return value;
}
function array(value: Json | undefined, field: string): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected an array: ${field}`);
  return value;
}
function section(value: Json | undefined, field: string): ObjectJson {
  if (value === undefined) return {};
  if (!object(value)) throw new Error(`Expected an object: ${field}`);
  return value;
}
function severity(value: Json | undefined): Json | undefined {
  if (Array.isArray(value)) return value.length === 1 ? severity(value[0]) : value;
  return value === 2
    ? "error"
    : value === 1
      ? "warn"
      : value === 0 || value === "allow"
        ? "off"
        : value;
}
function edit(text: string, path: (string | number)[], value: Json): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: text.includes("\r\n") ? "\r\n" : "\n",
      },
    }),
  );
}

// Match the two packaged native artifacts, not a Tamo-owned installation marker.
async function patched(cwd: string): Promise<boolean> {
  const req = createRequire(join(cwd, "package.json"));
  const platform = `${process.platform}-${process.arch}`;
  const suffix =
    process.platform === "win32" ? "-msvc" : process.platform === "linux" ? "-gnu" : "";
  const tsgo = req.resolve("@effect/tsgo/package.json");
  const replacements = dirname(
    createRequire(tsgo).resolve(`@effect/tsgo-${platform}/package.json`),
  );
  const ox = req.resolve("oxlint/package.json");
  const binding = createRequire(ox).resolve(`@oxlint/binding-${platform}${suffix}/package.json`);
  const bindingInfo = json(await readFile(binding, "utf8"), binding);
  if (typeof bindingInfo.main !== "string")
    throw new Error("Oxlint native package has no main entry.");
  const tsg = createRequire(req.resolve("oxlint-tsgolint/package.json")).resolve(
    `@oxlint-tsgolint/${platform}/package.json`,
  );

  for (const [component, version, target] of [
    ["oxlint", versions.oxlint, join(dirname(binding), bindingInfo.main)],
    [
      "oxlint-tsgolint",
      versions["oxlint-tsgolint"],
      join(dirname(tsg), process.platform === "win32" ? "tsgolint.exe" : "tsgolint"),
    ],
  ]) {
    const expected = join(replacements, "artifacts", component, version, basename(target));
    const hash = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    if ((await hash(target)) !== (await hash(expected))) return false;
  }
  return (await readFile(join(dirname(ox), "dist/index.d.ts"), "utf8")).includes('"effecttsgo"');
}

// Inspection state shared by the planning phases; conflicts and evidence are
// appended in phase order.
type PlanningState = {
  cwd: string;
  inspect: (path: string) => Promise<string | null>;
  conflicts: string[];
  evidence: string[];
};

async function rejectUnsupportedLayout(state: PlanningState): Promise<void> {
  const { cwd, inspect, conflicts } = state;
  for (let parent = dirname(cwd); ; parent = dirname(parent)) {
    if (parent !== cwd && (await inspect(join(parent, "pnpm-workspace.yaml"))) !== null)
      conflicts.push(
        "Target belongs to a parent pnpm workspace; workspace installation is outside Slice 1.",
      );
    if (parent === dirname(parent)) break;
  }

  for (const marker of [
    "pnpm-workspace.yaml",
    "oxlint.config.ts",
    "oxlint.config.mts",
    "oxlint.config.js",
  ]) {
    if ((await inspect(marker)) !== null) conflicts.push(`Unsupported in Slice 1: ${marker}`);
  }
}

async function inspectManifest(
  state: PlanningState,
): Promise<{ manifestText: string; manifest: ObjectJson }> {
  const manifestText = await state.inspect("package.json");
  if (manifestText === null) throw new Error("Target must contain package.json.");
  const manifest = json(manifestText, "package.json");
  if (manifest.workspaces !== undefined)
    state.conflicts.push("Workspace manifests are outside Slice 1.");
  if (typeof manifest.packageManager !== "string" || !/^pnpm@\d/.test(manifest.packageManager))
    state.conflicts.push("Target must declare a pnpm packageManager.");
  await state.inspect("pnpm-lock.yaml");
  return { manifestText, manifest };
}

function checkDependency(
  state: PlanningState,
  name: string,
  version: string,
  declared: Json | undefined,
  installed: string | null,
): { installed: boolean; needsInstall: boolean } {
  if (declared !== undefined && typeof declared !== "string")
    throw new Error(`Invalid dependency declaration: ${name}`);
  if ((name === "effect" || name === "oxlint") && (!declared || installed === null))
    state.conflicts.push(`${name} must already be declared and installed.`);
  if (installed !== null) {
    const actual = json(installed, name).version;
    if (typeof actual !== "string") throw new Error(`Invalid installed package version: ${name}`);
    if (actual !== version)
      state.conflicts.push(`${name}: expected ${version}, found ${actual}. No automatic upgrade.`);
    else state.evidence.push(`${name} ${version} installed`);
    return { installed: true, needsInstall: false };
  }
  if (declared && declared !== version)
    state.conflicts.push(`Cannot establish compatibility for uninstalled ${name} (${declared}).`);
  return { installed: false, needsInstall: true };
}

async function planDependencies(
  state: PlanningState,
  manifest: ObjectJson,
  manifestText: string,
): Promise<{ nextManifest: string; needsInstall: boolean; allInstalled: boolean }> {
  const dependencies = {
    ...section(manifest.devDependencies, "devDependencies"),
    ...section(manifest.dependencies, "dependencies"),
  };
  let needsInstall = false;
  let allInstalled = true;
  let nextManifest = manifestText;
  for (const [name, version] of Object.entries(versions)) {
    const installed = await state.inspect(`node_modules/${name}/package.json`);
    const declared = dependencies[name];
    const outcome = checkDependency(state, name, version, declared, installed);
    allInstalled = allInstalled && outcome.installed;
    needsInstall = needsInstall || outcome.needsInstall;
    if (!declared && name !== "effect" && name !== "oxlint") {
      nextManifest = edit(nextManifest, ["devDependencies", name], version);
      needsInstall = true;
    }
  }
  return { nextManifest, needsInstall, allInstalled };
}

function planPrepareScript(
  state: PlanningState,
  manifest: ObjectJson,
  manifestText: string,
): string {
  const scripts = section(manifest.scripts, "scripts");
  if (scripts.prepare !== undefined && typeof scripts.prepare !== "string")
    throw new Error("prepare must be a string.");
  const prepare = scripts.prepare ?? "";
  if (prepare.split(" && ").includes(patch)) return manifestText;
  // Limit composition to literal command chains; do not reinterpret shell programs.
  if (
    prepare &&
    (!/^[\w .:/\\-]+(?: && [\w .:/\\-]+)*$/.test(prepare) || prepare.includes("effect-tsgo"))
  ) {
    state.conflicts.push(
      "Existing prepare script requires manual composition with the Effect patch command.",
    );
    return manifestText;
  }
  return edit(manifestText, ["scripts", "prepare"], prepare ? `${prepare} && ${patch}` : patch);
}

async function loadConfig(
  state: PlanningState,
): Promise<{ configName: string; original: string; config: ObjectJson }> {
  const configs = await Promise.all([
    state.inspect(".oxlintrc.json"),
    state.inspect(".oxlintrc.jsonc"),
  ]);
  if (configs.filter((v) => v !== null).length !== 1)
    throw new Error("Expected exactly one .oxlintrc.json or .oxlintrc.jsonc.");
  const configName = configs[0] !== null ? ".oxlintrc.json" : ".oxlintrc.jsonc";
  const original = configs[0] ?? configs[1]!;
  return { configName, original, config: json(original, configName) };
}

function isTestExceptionOverride(override: ObjectJson): boolean {
  const files = array(override.files, "override.files");
  return (
    files.length === 2 &&
    files.includes("**/test/**") &&
    files.includes("scripts/**") &&
    override.excludedFiles === undefined
  );
}

function check(state: PlanningState, value: ObjectJson, location: string, exception = false): void {
  if (section(value.options, "options").typeAware === false)
    state.conflicts.push(`${location}: typeAware is explicitly false.`);
  for (const [rule, setting] of Object.entries(section(value.rules, "rules"))) {
    if (
      rule in requiredRules &&
      severity(setting) !==
        (exception && rule === "effecttsgo/strict-effect-provide" ? "off" : requiredRules[rule])
    )
      state.conflicts.push(`${location}: conflicting ${rule}.`);
  }
  checkOverrides(state, value, location);
}

function checkOverrides(state: PlanningState, value: ObjectJson, location: string): void {
  for (const override of array(value.overrides, "overrides")) {
    if (!object(override)) throw new Error(`Invalid override in ${location}`);
    const exception = isTestExceptionOverride(override);
    const relevant = Object.keys(section(override.rules, "override.rules")).some(
      (rule) => rule in requiredRules,
    );
    if (relevant && !exception)
      state.conflicts.push(`${location}: Effect rules in a custom override require manual review.`);
    if (
      override.extends !== undefined ||
      override.plugins !== undefined ||
      override.jsPlugins !== undefined ||
      override.options !== undefined
    )
      state.conflicts.push(`${location}: config-changing overrides are unsupported.`);
    check(state, { rules: section(override.rules, "override.rules") }, location, exception);
  }
}

function resolveInheritedEntry(
  cwd: string,
  entry: Json,
  parent: string,
): { path: string; name: string } {
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

function rejectManualInheritedConfig(inherited: ObjectJson, entry: string): void {
  if (
    inherited.plugins !== undefined ||
    inherited.jsPlugins !== undefined ||
    inherited.options !== undefined ||
    inherited.overrides !== undefined
  )
    throw new Error(
      `Inherited plugin/options/override configuration requires manual review: ${entry}`,
    );
}

async function inheritance(
  state: PlanningState,
  value: ObjectJson,
  parent: string,
  configName: string,
  visited: Set<string>,
): Promise<void> {
  for (const entry of array(value.extends, "extends")) {
    if (entry === preset && parent === resolve(state.cwd, configName)) continue;
    const { path, name } = resolveInheritedEntry(state.cwd, entry, parent);
    if (visited.has(path))
      throw new Error("Repeated/cyclic inherited configuration is unsupported.");
    visited.add(path);
    const text = await state.inspect(path);
    if (text === null) throw new Error(`Missing inherited config: ${name}`);
    const inherited = json(text, path);
    rejectManualInheritedConfig(inherited, name);
    check(state, inherited, name);
    await inheritance(state, inherited, path, configName, visited);
  }
}

function planConfigEdits(config: ObjectJson, original: string): string {
  let next = original;
  const extendsList = array(config.extends, "extends");
  if (!extendsList.includes(preset)) next = edit(next, ["extends"], [...extendsList, preset]);
  // Explicit root plugins must preserve upstream defaults when no list exists.
  const plugins =
    config.plugins === undefined
      ? ["typescript", "oxc", "unicorn"]
      : array(config.plugins, "plugins");
  if (!plugins.includes("effecttsgo")) next = edit(next, ["plugins"], [...plugins, "effecttsgo"]);
  next = edit(next, ["options", "typeAware"], true);
  for (const [rule, setting] of Object.entries(desiredRules))
    if (section(config.rules, "rules")[rule] === undefined)
      next = edit(next, ["rules", rule], setting);
  return next;
}

function planOverrideEdit(config: ObjectJson, next: string): string {
  const overrides = array(config.overrides, "overrides");
  const exception = overrides.findIndex(
    (v) =>
      object(v) &&
      Array.isArray(v.files) &&
      v.files.length === 2 &&
      v.files.includes("**/test/**") &&
      v.files.includes("scripts/**") &&
      v.excludedFiles === undefined,
  );
  if (exception < 0)
    return edit(
      next,
      ["overrides"],
      [
        ...overrides,
        {
          files: ["**/test/**", "scripts/**"],
          rules: { "effecttsgo/strict-effect-provide": "off" },
        },
      ],
    );
  // SAFETY: findIndex above matched this element against object(v), so the entry is an object.
  if (
    section((overrides[exception] as ObjectJson).rules, "rules")[
      "effecttsgo/strict-effect-provide"
    ] === undefined
  )
    return edit(next, ["overrides", exception, "rules", "effecttsgo/strict-effect-provide"], "off");
  return next;
}

function planPluginRegistration(
  cwd: string,
  config: ObjectJson,
  next: string,
  conflicts: string[],
): string {
  const jsPlugins = array(config.jsPlugins, "jsPlugins");
  const registration = { name: "tamo-effect", specifier: `./${plugin}` };
  const isPluginPath = (value: Json | undefined) =>
    typeof value === "string" &&
    value.startsWith(".") &&
    resolve(cwd, value) === resolve(cwd, plugin);
  const existing = jsPlugins.find(
    (v) =>
      isPluginPath(v) || (object(v) && (v.name === registration.name || isPluginPath(v.specifier))),
  );
  if (
    existing &&
    !(
      isPluginPath(existing) ||
      (object(existing) && existing.name === registration.name && isPluginPath(existing.specifier))
    )
  )
    conflicts.push("Plugin namespace/path tamo-effect is already registered differently.");
  if (!existing) return edit(next, ["jsPlugins"], [...jsPlugins, registration]);
  return next;
}

async function plan(context: ReadContext): Promise<Plan> {
  const cwd = resolve(context.cwd);
  const result: Plan = {
    extension: "effect-oxlint",
    cwd,
    inputs: [],
    evidence: [],
    conflicts: [],
    operations: [],
    validation: [
      "Check configuration and patch state",
      "Execute upstream and local rules on isolated TypeScript input",
    ],
  };
  const inspect = async (path: string) => {
    const full = resolve(cwd, path);
    const contents = await context.read(full);
    result.inputs.push({ path: full, hash: fingerprint(contents) });
    return contents;
  };
  const write = (path: string, before: string | null, after: string) => {
    if (before !== after)
      result.operations.push({ kind: "write", path: resolve(cwd, path), before, after });
  };
  const state: PlanningState = {
    cwd,
    inspect,
    conflicts: result.conflicts,
    evidence: result.evidence,
  };
  try {
    await rejectUnsupportedLayout(state);

    const { manifestText, manifest } = await inspectManifest(state);
    const { nextManifest, needsInstall, allInstalled } = await planDependencies(
      state,
      manifest,
      manifestText,
    );
    const finalManifest = planPrepareScript(state, manifest, nextManifest);

    const { configName, original, config } = await loadConfig(state);
    check(state, config, configName);
    await inheritance(state, config, resolve(cwd, configName), configName, new Set());

    let next = planConfigEdits(config, original);
    next = planOverrideEdit(config, next);
    next = planPluginRegistration(cwd, config, next, state.conflicts);

    const pluginBefore = await inspect(plugin);
    const pluginAfter = await readFile(resource, "utf8");
    if (pluginBefore !== null && pluginBefore !== pluginAfter)
      result.conflicts.push(`Existing ${plugin} differs; preserve it and review manually.`);

    write("package.json", manifestText, finalManifest);
    write(configName, original, next);
    write(plugin, pluginBefore, pluginAfter);

    if (needsInstall)
      result.operations.push({
        kind: "command",
        executable: "pnpm",
        args: ["install", "--ignore-scripts"],
        cwd,
        purpose:
          "Install declared dependencies and update pnpm-lock.yaml/node_modules (lifecycle scripts disabled)",
      });
    if (needsInstall || !allInstalled || !(await patched(cwd)))
      result.operations.push({
        kind: "command",
        executable: "pnpm",
        args: ["exec", "effect-tsgo", "patch", "--no-typescript", "--oxlint"],
        cwd,
        purpose: "Patch installed Oxlint and its type-aware engine",
      });
  } catch (error) {
    result.conflicts.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}

async function validate(cwd: string): Promise<string[]> {
  const current = await plan({ cwd, read });
  if (current.conflicts.length) return current.conflicts;
  if (current.operations.length)
    return ["Integration is incomplete; replanning still proposes changes."];
  const config =
    (await read(join(cwd, ".oxlintrc.json"))) !== null ? ".oxlintrc.json" : ".oxlintrc.jsonc";

  return withTempDirectory(".tamo-validation-", cwd, async (directory) => {
    const source =
      'import { Context, Effect, Layer } from "effect";\nclass Probe extends Context.Service<Probe, {}>()("Probe") { static defaultLayer = Layer.empty; }\nEffect.gen(function* () { Effect.succeed(1); return 1; });\nexport const provided = Effect.void.pipe(Effect.provide(Layer.empty));\nexport { Probe };\n';

    await write(join(directory, "probe.ts"), source);
    await write(join(directory, "test", "probe.ts"), source);

    const lint = await command(
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
      cwd,
    );
    if (!lint.stdout.trimStart().startsWith("{"))
      return [`Oxlint did not return JSON (${lint.code}).\n${lint.stdout}\n${lint.stderr}`];

    const output = json(lint.stdout, "Oxlint JSON output");
    const diagnostics = array(output.diagnostics, "diagnostics");
    const has = (file: string, code: string) =>
      diagnostics.some(
        (v) =>
          object(v) &&
          typeof v.filename === "string" &&
          v.filename.replaceAll("\\", "/").endsWith(file) &&
          v.code === code,
      );
    const ordinary = `${basename(directory)}/probe.ts`;
    const testFile = `${basename(directory)}/test/probe.ts`;
    const passed =
      lint.code === 1 &&
      has(ordinary, "effecttsgo(floating-effect)") &&
      has(ordinary, "tamo-effect(no-layer-in-service-class)") &&
      has(ordinary, "effecttsgo(strict-effect-provide)") &&
      has(testFile, "effecttsgo(floating-effect)") &&
      has(testFile, "tamo-effect(no-layer-in-service-class)") &&
      !has(testFile, "effecttsgo(strict-effect-provide)");
    return passed
      ? []
      : [
          `Controlled lint probe did not demonstrate the Effect rules and test override.\n${lint.stdout}\n${lint.stderr}`,
        ];
  });
}

export const effectOxlint: Extension = {
  id: "effect-oxlint",
  description: "Add the preferred Effect lint configuration to Oxlint",
  plan,
  validate,
};
