import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  AdjustResult,
  ApplyPlan,
  ArtifactContribution,
  ArtifactHandler,
  CombineResult,
  StructuralEdit,
} from "../handler.ts";
import {
  array,
  canonical,
  edit,
  json,
  object,
  removeKey,
  section,
  severity,
  type Json,
  type ObjectJson,
} from "../jsonc.ts";
import {
  combineExtraFields,
  combineState,
  lookupMap,
  mapField,
  mergeKnownEntries,
  omitEntry,
  ownerOf,
  placeField,
  unionKeyedMaps,
  unionValues,
  type CombineState,
  type ContributionOwner,
} from "../structure.ts";

// Handler for captured .oxlintrc.json/.oxlintrc.jsonc artifacts. It exposes
// the explicitly configured top-level rules as a customizable selector
// (SPEC 0.11) and understands how a captured config's contribution — extends
// entries, plugins, the typeAware option, explicit rules, overrides, and
// jsPlugins registrations — merges additively into a target config through
// targeted JSONC edits. All of this is generic Oxlint-config knowledge; which
// entries a setup contributes is recipe opinion, never handler preference.
const rulesSelector = mapField("rules");
const configNames = [".oxlintrc.json", ".oxlintrc.jsonc"];

function severityIsValid(value: Json | undefined): value is Json {
  if (typeof value === "string") return ["error", "warn", "off"].includes(value);
  if (value === 0 || value === 1 || value === 2) return true;
  if (Array.isArray(value) && value.length === 2) return severityIsValid(value[0]);
  return false;
}

function describe(value: Json | undefined): string {
  return JSON.stringify(value);
}

function adjust(
  artifactPath: string,
  contents: string,
  structuralEdit: StructuralEdit,
): AdjustResult {
  const conflicts: string[] = [];
  const evidence: string[] = [];
  if (structuralEdit.selector !== rulesSelector.name) {
    conflicts.push(
      `Unknown selector "${structuralEdit.selector}"; exposed selectors: ${rulesSelector.name}.`,
    );
    return { contents, conflicts, evidence };
  }

  const artifact = json(contents, artifactPath);
  const lookup = lookupMap(artifact, rulesSelector);
  if (lookup.state === "absent") {
    conflicts.push(`Selector "rules" is not present in ${artifactPath}.`);
    return { contents, conflicts, evidence };
  }
  if (lookup.state === "unsupported") {
    conflicts.push(`rules in ${artifactPath} is not a keyed map; unsupported structure.`);
    return { contents, conflicts, evidence };
  }

  const omit = omitEntry(lookup.map, structuralEdit.entry);
  if (omit.conflict) {
    conflicts.push(omit.conflict);
    return { contents, conflicts, evidence };
  }

  evidence.push(`omitted rules.${structuralEdit.entry}`);
  return { contents: removeKey(contents, ["rules", structuralEdit.entry]), conflicts, evidence };
}

// The validation boundary for adjusted configs: every remaining explicit
// rule must still carry a valid severity representation.
function validateAdjusted(artifactPath: string, contents: string): string[] {
  const conflicts: string[] = [];
  const artifact = json(contents, artifactPath);
  const lookup = lookupMap<Json>(artifact, rulesSelector);
  if (lookup.state !== "found") return conflicts;
  for (const [rule, setting] of Object.entries(lookup.map))
    if (!severityIsValid(setting))
      conflicts.push(`rules.${rule} in ${artifactPath} is not a valid rule severity.`);
  return conflicts;
}

// The contribution a captured config makes to a target project. Shapes are
// validated here; anything malformed throws with a field-specific message.
export type ConfigContribution = {
  extendsList: Json[];
  plugins: Json[];
  typeAware: Json | undefined;
  rules: Record<string, Json> | null;
  overrides: Json[];
  jsPlugins: Json[];
};

function parseContribution(contribution: ObjectJson): ConfigContribution {
  const options =
    contribution.options === undefined ? {} : section(contribution.options, "options");
  const rules = lookupMap<Json>(contribution, rulesSelector);
  return {
    extendsList: array(contribution.extends, "extends"),
    plugins: array(contribution.plugins, "plugins"),
    typeAware: options.typeAware,
    rules: rules.state === "found" ? rules.map : null,
    overrides: array(contribution.overrides, "overrides"),
    jsPlugins: array(contribution.jsPlugins, "jsPlugins"),
  };
}

function filesOf(override: ObjectJson, field: string): string[] {
  return array(override.files, `${field}.files`).map((entry) => {
    if (typeof entry !== "string") throw new Error(`Expected file patterns: ${field}.files`);
    return entry;
  });
}

function sameOverrideFiles(patterns: string[], override: ObjectJson): boolean {
  const existing = filesOf(override, "override");
  return (
    override.excludedFiles === undefined &&
    patterns.length === existing.length &&
    patterns.every((pattern) => existing.includes(pattern))
  );
}

// An override the contribution does not itself define may not touch
// contributed rules: its effective value would need manual review.
function checkUntouchedRules(
  overrideRules: ObjectJson,
  rules: Record<string, Json>,
  configName: string,
  conflicts: string[],
): void {
  for (const rule of Object.keys(rules))
    if (rule in overrideRules)
      conflicts.push(
        `${configName} override touches contributed rule ${rule}; effective value requires manual review.`,
      );
}

function changesConfiguration(override: ObjectJson): boolean {
  return (
    override.extends !== undefined ||
    override.plugins !== undefined ||
    override.jsPlugins !== undefined ||
    override.options !== undefined
  );
}

// Effective rule values can only be established for a bounded target
// arrangement: typeAware not explicitly disabled, no config-changing
// overrides, no overrides touching contributed rules outside the contributed
// override instances themselves (SPEC 8.2).
function checkOverrideArrangement(
  target: ObjectJson,
  contributed: ConfigContribution,
  configName: string,
  conflicts: string[],
): void {
  if (section(target.options, `${configName}.options`).typeAware === false)
    conflicts.push(`${configName}: typeAware is explicitly false.`);

  for (const override of array(target.overrides, `${configName}.overrides`)) {
    if (!object(override)) throw new Error(`Invalid override in ${configName}`);
    const patterns = contributed.overrides
      .filter(object)
      .some((candidate) => sameOverrideFiles(filesOf(candidate, "contribution"), override));
    if (!patterns && contributed.rules)
      checkUntouchedRules(
        section(override.rules, "override.rules"),
        contributed.rules,
        configName,
        conflicts,
      );
    if (changesConfiguration(override))
      conflicts.push(`${configName} has config-changing overrides; unsupported arrangement.`);
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

export type InheritedConfig = { name: string; path: string; config: ObjectJson };

// Walk the target's extends chain within a bounded arrangement: relative
// JSON/JSONC inside the project, no cycles, no config-changing inherited
// entries. Entries the contribution itself adds at the root are skipped —
// their contents are the recipe's responsibility. Exported so executable
// recipe behavior can check the same inherited state read-only; reads are
// expected to be tracked, so no input snapshots are returned here.
export async function collectInheritedConfigs(
  cwd: string,
  configName: string,
  config: ObjectJson,
  read: (path: string) => Promise<string | null>,
  skipAtRoot: string[],
): Promise<{ inherited: InheritedConfig[] }> {
  const inherited: InheritedConfig[] = [];
  const visited = new Set<string>();

  const walk = async (value: ObjectJson, parent: string, isRoot: boolean): Promise<void> => {
    for (const entry of array(value.extends, "extends")) {
      if (isRoot && typeof entry === "string" && skipAtRoot.includes(entry)) continue;
      const { path, name } = resolveInheritedEntry(cwd, entry, parent);
      if (visited.has(path))
        throw new Error("Repeated/cyclic inherited configuration is unsupported.");
      visited.add(path);
      const text = await read(path);
      if (text === null) throw new Error(`Missing inherited config: ${name}`);
      const parsed = json(text, path);
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

// Explicit rule values in the target root and inherited configs must match
// the contributed severities; inherited settings must not silently replace
// the contribution.
function checkInheritedRules(
  configs: { name: string; config: ObjectJson }[],
  rules: Record<string, Json>,
  conflicts: string[],
): void {
  for (const { name, config } of configs)
    for (const [rule, required] of Object.entries(rules)) {
      const setting = section(config.rules, `${name}.rules`)[rule];
      if (
        setting !== undefined &&
        JSON.stringify(severity(setting)) !== JSON.stringify(severity(required))
      )
        conflicts.push(`${name}: conflicting ${rule}.`);
    }
}

type MergeState = { next: string; changed: boolean; conflicts: string[]; evidence: string[] };

// Merge contributed rules into the target's rules map: identical severities
// are left unchanged, differing severities are blocking conflicts, and
// absent rules are added through targeted JSONC edits.
function mergeRules(
  merge: MergeState,
  existingRules: Record<string, Json>,
  contributed: Record<string, Json>,
): void {
  for (const [rule, setting] of Object.entries(contributed)) {
    if (!severityIsValid(severity(setting))) {
      merge.conflicts.push(`Contributed rule ${rule} does not carry a valid severity.`);
      continue;
    }
    if (rule in existingRules) {
      // Full-value comparison: rule settings can carry nested config beyond
      // severity, and a severity-only match must not silently drop it.
      if (canonical(existingRules[rule]) === canonical(setting)) {
        merge.evidence.push(`rule ${rule} already set`);
        continue;
      }
      merge.conflicts.push(
        `${rule}: target sets ${describe(existingRules[rule])}, contribution requires ${describe(setting)}.`,
      );
      continue;
    }
    merge.next = edit(merge.next, ["rules", rule], setting);
    merge.changed = true;
    merge.evidence.push(`add rule ${rule}`);
  }
}

// Append contributed extends/plugins entries that are not already present;
// order is preserved and duplicates are skipped.
function appendMissing(
  merge: MergeState,
  field: string,
  existing: Json[],
  contributed: Json[],
): void {
  const missing = contributed.filter(
    (entry) => !existing.some((present) => JSON.stringify(present) === JSON.stringify(entry)),
  );
  if (!missing.length) return;
  merge.next = edit(merge.next, [field], [...existing, ...missing]);
  merge.changed = true;
  merge.evidence.push(`add ${field}: ${missing.map(describe).join(", ")}`);
}

function contributePlugins(merge: MergeState, target: ObjectJson, contributed: Json[]): void {
  if (!contributed.length) return;
  if (target.plugins === undefined) {
    merge.next = edit(merge.next, ["plugins"], contributed);
    merge.changed = true;
    merge.evidence.push("set plugins");
    return;
  }
  appendMissing(merge, "plugins", array(target.plugins, "plugins"), contributed);
}

function contributeTypeAware(
  merge: MergeState,
  target: ObjectJson,
  desired: Json | undefined,
): void {
  if (desired === undefined) return;
  const current = section(target.options, "options").typeAware;
  if (current === desired) return;
  if (current !== undefined) {
    merge.conflicts.push(
      `options.typeAware: target sets ${describe(current)}, contribution requires ${describe(desired)}.`,
    );
    return;
  }
  merge.next = edit(merge.next, ["options", "typeAware"], desired);
  merge.changed = true;
  merge.evidence.push("set options.typeAware");
}

function mergeOverride(
  merge: MergeState,
  index: number,
  overrideRules: Record<string, Json>,
  contributedRules: Record<string, Json>,
): void {
  for (const [rule, setting] of Object.entries(contributedRules)) {
    if (!severityIsValid(severity(setting))) {
      merge.conflicts.push(`Contributed override rule ${rule} does not carry a valid severity.`);
      continue;
    }
    if (rule in overrideRules) {
      if (canonical(overrideRules[rule]) === canonical(setting)) continue;
      merge.conflicts.push(
        `override ${rule}: target sets ${describe(overrideRules[rule])}, contribution requires ${describe(setting)}.`,
      );
      continue;
    }
    merge.next = edit(merge.next, ["overrides", index, "rules", rule], setting);
    merge.changed = true;
    merge.evidence.push(`add override rule ${rule}`);
  }
}

function contributeOverrides(
  merge: MergeState,
  target: ObjectJson,
  contributed: ConfigContribution,
): void {
  if (!contributed.overrides.length) return;
  const targetOverrides = array(target.overrides, "overrides");
  contributed.overrides.forEach((candidate, contributedIndex) => {
    if (!object(candidate)) throw new Error("Invalid contributed override");
    const patterns = filesOf(candidate, `contribution.overrides.${contributedIndex}`);
    const candidateRules = lookupMap<Json>(candidate, rulesSelector);
    if (candidateRules.state !== "found")
      throw new Error("Contributed overrides must carry a rules map");
    const index = targetOverrides.findIndex(
      (override) => object(override) && sameOverrideFiles(patterns, override),
    );
    if (index < 0) {
      merge.next = edit(merge.next, ["overrides"], [...targetOverrides, candidate]);
      merge.changed = true;
      merge.evidence.push(`add override for ${patterns.join(", ")}`);
      return;
    }
    // SAFETY: findIndex above matched this element against object(override).
    const override = targetOverrides[index] as ObjectJson;
    const existingRules = lookupMap<Json>(override, rulesSelector);
    mergeOverride(
      merge,
      index,
      existingRules.state === "found" ? existingRules.map : {},
      candidateRules.map,
    );
  });
}

function pluginPathMatches(cwd: string, value: Json | undefined, specifier: string): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(".") &&
    resolve(cwd, value) === resolve(cwd, specifier)
  );
}

// Register contributed jsPlugins entries: an identical registration is a
// no-op, a colliding name or path registered differently is a conflict, and
// an absent registration is appended.
function contributeJsPlugins(
  merge: MergeState,
  cwd: string,
  target: ObjectJson,
  contributed: Json[],
): void {
  if (!contributed.length) return;
  const jsPlugins = array(target.jsPlugins, "jsPlugins");
  contributed.forEach((entry) => {
    if (!object(entry) || typeof entry.name !== "string" || typeof entry.specifier !== "string")
      throw new Error("Contributed jsPlugins entries must be { name, specifier } objects");
    const { name, specifier } = entry;
    const matches = (value: Json | undefined): boolean =>
      pluginPathMatches(cwd, value, specifier) ||
      (object(value) &&
        (pluginPathMatches(cwd, value.specifier, specifier) || value.name === name));
    const identical = (value: Json | undefined): boolean =>
      pluginPathMatches(cwd, value, specifier) ||
      (object(value) && value.name === name && pluginPathMatches(cwd, value.specifier, specifier));
    const existing = jsPlugins.find(matches);
    if (existing && !identical(existing)) {
      merge.conflicts.push(`Plugin namespace/path ${name} is already registered differently.`);
      return;
    }
    if (existing) {
      merge.evidence.push(`jsPlugins ${name} already registered`);
      return;
    }
    merge.next = edit(merge.next, ["jsPlugins"], [...jsPlugins, entry]);
    merge.changed = true;
    merge.evidence.push(`register jsPlugins ${name}`);
  });
}

// Read-only inherited-config check across the target root and its bounded
// chain: rules the contribution requires must not be silently replaced by
// inherited settings. Returns conflicts; throws nothing.
async function collectInheritedConflicts(
  cwd: string,
  configName: string,
  target: ObjectJson,
  contributed: ConfigContribution,
  read: (path: string) => Promise<string | null>,
): Promise<string[]> {
  try {
    const walk = await collectInheritedConfigs(
      cwd,
      configName,
      target,
      read,
      contributed.extendsList.filter((entry): entry is string => typeof entry === "string"),
    );
    if (!contributed.rules) return [];
    const conflicts: string[] = [];
    checkInheritedRules(walk.inherited, contributed.rules, conflicts);
    return conflicts;
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

// Contribution coverage: the merge below consumes only extends, plugins,
// options.typeAware, rules, overrides, and jsPlugins. Any other contributed
// field whose value differs from the target would be silently ignored, so it
// blocks loudly instead. Identical values need no application.
function contributionCoverage(
  target: ObjectJson,
  contribution: ObjectJson,
  configName: string,
): { conflicts: string[]; evidence: string[] } {
  const extra = Object.keys(contribution).filter(
    (field) =>
      !["extends", "plugins", "options", "rules", "overrides", "jsPlugins"].includes(field),
  );
  const optionValues =
    contribution.options !== undefined ? section(contribution.options, "options") : {};
  const targetOptions = target.options !== undefined ? section(target.options, "options") : {};
  const differingOptions = Object.keys(optionValues).filter(
    (field) =>
      field !== "typeAware" && canonical(targetOptions[field]) !== canonical(optionValues[field]),
  );
  const differing = extra.filter(
    (field) => canonical(target[field]) !== canonical(contribution[field]),
  );
  if (!differing.length && !differingOptions.length)
    return {
      conflicts: [],
      evidence: [
        ...extra.map((field) => `${field} already matches in ${configName}`),
        ...Object.keys(optionValues)
          .filter((field) => field !== "typeAware")
          .map((field) => `options.${field} already matches in ${configName}`),
      ],
    };
  const fields = [...differing, ...differingOptions.map((field) => `options.${field}`)];
  return {
    conflicts: [
      `${configName} contribution carries unsupported field(s): ${fields.join(", ")}. Only extends, plugins, options.typeAware, rules, overrides, and jsPlugins can be contributed.`,
    ],
    evidence: [],
  };
}

async function planApply({
  cwd,
  artifactPath,
  contents,
  read,
}: {
  cwd: string;
  artifactPath: string;
  contents: string;
  read: (path: string) => Promise<string | null>;
}): Promise<ApplyPlan> {
  const conflicts: string[] = [];
  const evidence: string[] = [];

  const texts = await Promise.all(configNames.map((name) => read(join(cwd, name))));
  const present = configNames.filter((_, index) => texts[index] !== null);
  if (present.length === 0) {
    // Absent target (the create case): materialize the complete resolved
    // artifact at its own path, which also settles the json/jsonc choice.
    // Verbatim bytes, not a rebuild from understood fields.
    const configPath = join(cwd, artifactPath);
    return {
      operations: [{ kind: "write" as const, path: configPath, before: null, after: contents }],
      evidence: [`create ${artifactPath} from the recipe artifact`],
      conflicts,
    };
  }
  if (present.length !== 1) {
    conflicts.push(
      `Expected exactly one .oxlintrc.json or .oxlintrc.jsonc in the target; found ${present.length}.`,
    );
    return { operations: [], evidence, conflicts };
  }
  const configName = present[0]!;
  const configPath = join(cwd, configName);
  const targetText = texts[configNames.indexOf(configName)]!;

  const target = json(targetText, configName);
  const contribution = json(contents, "adjusted Oxlint config");
  const contributed = parseContribution(contribution);

  const coverage = contributionCoverage(target, contribution, configName);
  conflicts.push(...coverage.conflicts);
  evidence.push(...coverage.evidence);
  if (conflicts.length) return { operations: [], evidence, conflicts };

  const targetRules = lookupMap<Json>(target, rulesSelector);
  if (targetRules.state === "unsupported") {
    conflicts.push(`Target ${configName} rules is not a keyed map; unsupported structure.`);
    return { operations: [], evidence, conflicts };
  }

  checkOverrideArrangement(target, contributed, configName, conflicts);
  conflicts.push(...(await collectInheritedConflicts(cwd, configName, target, contributed, read)));
  if (conflicts.length) return { operations: [], evidence, conflicts };

  const merge: MergeState = { next: targetText, changed: false, conflicts, evidence };
  appendMissing(merge, "extends", array(target.extends, "extends"), contributed.extendsList);
  contributePlugins(merge, target, contributed.plugins);
  contributeTypeAware(merge, target, contributed.typeAware);
  if (contributed.rules)
    mergeRules(merge, targetRules.state === "found" ? targetRules.map : {}, contributed.rules);
  contributeOverrides(merge, target, contributed);
  contributeJsPlugins(merge, cwd, target, contributed.jsPlugins);

  const operations = merge.changed
    ? [{ kind: "write" as const, path: configPath, before: targetText, after: merge.next }]
    : [];
  return { operations, evidence, conflicts };
}

// Merge one keyed rule map across every contribution: independent keys
// merge, canonically identical full values dedupe, differing values
// conflict with both contributing instances named. Full values are
// preserved exactly — array/object rule configurations included.
function combineRules(
  state: CombineState,
  contributions: ArtifactContribution[],
  parsed: ObjectJson[],
): void {
  const maps: { owner: string; map: Record<string, Json> }[] = [];
  for (const [index, contribution] of contributions.entries()) {
    const lookup = lookupMap<Json>(parsed[index]!, rulesSelector);
    if (lookup.state === "absent") continue;
    if (lookup.state === "unsupported") {
      state.conflicts.push(
        `rules from ${ownerOf(contribution)} is not a keyed map; unsupported structure.`,
      );
      continue;
    }
    maps.push({
      owner: ownerOf(contribution),
      map: validRules(lookup.map, ownerOf(contribution), state.conflicts),
    });
  }
  const known = unionKeyedMaps(
    maps,
    (rule, first, second) =>
      `${rule}: ${first.owner} sets ${describe(first.value)}, ${second.owner} sets ${describe(second.value)}.`,
    state.conflicts,
  );
  mergeKnownEntries(state, ["rules"], parsed[0]!["rules"], known, "rules");
}

function validRules(
  map: Record<string, Json>,
  owner: string,
  conflicts: string[],
): Record<string, Json> {
  const clean: Record<string, Json> = {};
  for (const [rule, setting] of Object.entries(map)) {
    if (!severityIsValid(severity(setting))) {
      conflicts.push(`Contributed rule ${rule} from ${owner} does not carry a valid severity.`);
      continue;
    }
    clean[rule] = setting;
  }
  return clean;
}

// Merge option keys across every contribution: independent keys merge,
// identical duplicates dedupe, differing duplicates conflict. Supported
// and unsupported keys share this rule — an unsupported nested value that
// differs has nowhere to go, so it conflicts instead of dropping.
function combineOptions(
  state: CombineState,
  contributions: ArtifactContribution[],
  parsed: ObjectJson[],
): void {
  const maps: { owner: string; map: Record<string, Json> }[] = [];
  for (const [index, contribution] of contributions.entries()) {
    const value = parsed[index]!["options"];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      state.conflicts.push(`options from ${ownerOf(contribution)} is not an object.`);
      continue;
    }
    maps.push({ owner: ownerOf(contribution), map: value });
  }
  const known = unionKeyedMaps(
    maps,
    (key, first, second) =>
      `options.${key}: ${first.owner} sets ${describe(first.value)}, ${second.owner} sets ${describe(second.value)}.`,
    state.conflicts,
  );
  mergeKnownEntries(state, ["options"], parsed[0]!["options"], known, "options");
}

// Merge one whole-array field across every contribution: supplied by one
// contribution it is preserved, canonically identical collections
// dedupe, and differing collections conflict — positional union would
// silently choose an order for extends, plugins, and overrides.
function combineCollection(
  state: CombineState,
  contributions: ArtifactContribution[],
  parsed: ObjectJson[],
  field: string,
): void {
  const values: { owner: string; value: Json | undefined }[] = [];
  for (const [index, contribution] of contributions.entries()) {
    const value = parsed[index]![field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      state.conflicts.push(`${field} from ${ownerOf(contribution)} is not an array.`);
      continue;
    }
    values.push({ owner: ownerOf(contribution), value });
  }
  const distinct = unionValues(values);
  if (distinct.length > 1)
    state.conflicts.push(
      `${field} differs between ${distinct.map((seen) => seen.owner).join(" and ")}; positional union would silently choose an order.`,
    );
  else if (distinct.length === 1) placeField(state, field, distinct[0]!.value);
}

// Merge jsPlugins registrations by registration identity (name plus
// specifier): identical registrations dedupe, identity collisions with
// differing registrations conflict, disjoint registrations merge.
function combineJsPlugins(
  state: CombineState,
  contributions: ArtifactContribution[],
  parsed: ObjectJson[],
): void {
  const known = new Map<string, ContributionOwner>();
  const names = new Map<string, ContributionOwner>();
  for (const [index, contribution] of contributions.entries()) {
    const value = parsed[index]!["jsPlugins"];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      state.conflicts.push(`jsPlugins from ${ownerOf(contribution)} is not an array.`);
      continue;
    }
    for (const entry of value) registerJsPlugin(state, ownerOf(contribution), entry, known, names);
  }
  if (!known.size) return;
  placeField(
    state,
    "jsPlugins",
    [...known.values()].map((seen) => seen.value),
  );
}

function registerJsPlugin(
  state: CombineState,
  owner: string,
  entry: Json,
  known: Map<string, ContributionOwner>,
  names: Map<string, ContributionOwner>,
): void {
  if (!object(entry) || typeof entry.name !== "string" || typeof entry.specifier !== "string") {
    state.conflicts.push(`jsPlugins entries from ${owner} must be { name, specifier } objects.`);
    return;
  }
  const key = canonical(entry);
  if (known.has(key)) return;
  const sameName = names.get(entry.name);
  if (sameName !== undefined && canonical(sameName.value) !== key) {
    state.conflicts.push(
      `jsPlugins ${entry.name}: ${sameName.owner} registers ${describe(sameName.value)}, ${owner} registers ${describe(entry)}.`,
    );
    return;
  }
  known.set(key, { owner, value: entry });
  if (sameName === undefined) names.set(entry.name, { owner, value: entry });
}

// Any other top-level field survives when unique or canonically identical,
// and conflicts explicitly when contributions disagree about it.
// Combine several same-path Oxlint config contributions into one, before
// any target merge runs. Safe combination only where semantics are already
// understood: rule and option keys merge on identity, whole collections
// dedupe on identity and conflict on divergence, and anything else
// survives when unique or identical. Text surgery on the first
// contribution preserves its formatting.
function combine(contributions: ArtifactContribution[]): CombineResult {
  const parsed = contributions.map((contribution) =>
    json(contribution.contents, `${contribution.path} from ${ownerOf(contribution)}`),
  );
  const state = combineState(contributions[0]!.contents, parsed[0]!);
  combineRules(state, contributions, parsed);
  combineOptions(state, contributions, parsed);
  for (const field of ["extends", "plugins", "overrides"])
    combineCollection(state, contributions, parsed, field);
  combineJsPlugins(state, contributions, parsed);
  combineExtraFields(
    state,
    contributions,
    parsed,
    new Set(["extends", "plugins", "options", "rules", "overrides", "jsPlugins"]),
  );
  return {
    contents: state.next,
    evidence: [
      `combined ${contributions.length} contributions from ${contributions.map(ownerOf).join(", ")}`,
    ],
    conflicts: state.conflicts,
  };
}

export const oxlintConfigHandler: ArtifactHandler = {
  id: "oxlint-config",
  handles: (artifactPath) => configNames.includes(artifactPath),
  adjust,
  validateAdjusted,
  planApply,
  combine,
};
