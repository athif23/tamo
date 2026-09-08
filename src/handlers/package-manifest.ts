import { join } from "node:path";
import type {
  AdjustResult,
  ApplyPlan,
  ArtifactContribution,
  ArtifactHandler,
  CombineResult,
  StructuralEdit,
} from "../handler.ts";
import { canonical, edit, json, removeKey, type Json, type ObjectJson } from "../jsonc.ts";
import {
  combineExtraFields,
  combineState,
  lookupMap,
  mapField,
  mergeKnownEntries,
  omitEntry,
  ownerOf,
  unionKeyedMaps,
  unionValues,
  placeField,
  type CombineState,
  type MapSelector,
} from "../structure.ts";

// Handler for captured package.json artifacts. It exposes only the
// dependencies and devDependencies maps as selectable structure (SPEC 0.11);
// every other manifest field is opaque. Application is a contribution: the
// adjusted dependency entries are merged additively into the target manifest,
// which keeps its name, scripts, package manager, and unrelated dependencies.
// Omission removes an entry from the contribution; it never deletes anything
// from the target (SPEC 0.6).
const selectors = [mapField("dependencies"), mapField("devDependencies")];
const scriptsSelector = mapField("scripts");

function adjust(
  artifactPath: string,
  contents: string,
  structuralEdit: StructuralEdit,
): AdjustResult {
  const conflicts: string[] = [];
  const evidence: string[] = [];
  const selector = selectors.find((candidate) => candidate.name === structuralEdit.selector);
  if (!selector) {
    conflicts.push(
      `Unknown selector "${structuralEdit.selector}"; exposed selectors: ${selectors.map((s) => s.name).join(", ")}.`,
    );
    return { contents, conflicts, evidence };
  }

  const artifact = json(contents, artifactPath);
  const lookup = lookupMap(artifact, selector);
  if (lookup.state === "absent") {
    conflicts.push(`Selector "${selector.name}" is not present in ${artifactPath}.`);
    return { contents, conflicts, evidence };
  }
  if (lookup.state === "unsupported") {
    conflicts.push(
      `${selector.name} in ${artifactPath} is not a keyed map; unsupported structure.`,
    );
    return { contents, conflicts, evidence };
  }

  const omit = omitEntry(lookup.map, structuralEdit.entry);
  if (omit.conflict) {
    conflicts.push(omit.conflict);
    return { contents, conflicts, evidence };
  }

  evidence.push(`omitted ${selector.name}.${structuralEdit.entry}`);
  return {
    contents: removeKey(contents, [selector.name, structuralEdit.entry]),
    conflicts,
    evidence,
  };
}

// Every entry of a contributed map must be a non-empty string; the label
// names the map and the noun describes the expected value in conflicts.
function checkStringMap(
  map: Record<string, Json>,
  label: string,
  noun: string,
  artifactPath: string,
  conflicts: string[],
): void {
  for (const [name, value] of Object.entries(map))
    if (typeof value !== "string" || !value)
      conflicts.push(`${label}.${name} in ${artifactPath} is not a ${noun}.`);
}

// The validation boundary for adjusted manifests: dependency maps must still
// map package names to version strings, scripts must map to command strings,
// and version/packageManager must be version strings when present.
function validateAdjusted(artifactPath: string, contents: string): string[] {
  const conflicts: string[] = [];
  const artifact = json(contents, artifactPath);
  for (const selector of selectors) {
    const lookup = lookupMap<Json>(artifact, selector);
    if (lookup.state === "found")
      checkStringMap(lookup.map, selector.name, "version string", artifactPath, conflicts);
  }
  const scripts = lookupMap<Json>(artifact, scriptsSelector);
  if (scripts.state === "found")
    checkStringMap(scripts.map, "scripts", "command string", artifactPath, conflicts);
  for (const field of ["version", "packageManager"]) {
    const value = artifact[field];
    if (value !== undefined && (typeof value !== "string" || !value))
      conflicts.push(`${field} in ${artifactPath} is not a version string.`);
  }
  return conflicts;
}

type MergeState = { next: string; changed: boolean; conflicts: string[]; evidence: string[] };

// Merge one contributed dependency section into the target manifest.
// Identical entries are left unchanged; differing entries are blocking
// conflicts (no automatic upgrades).
function mergeSection(
  merge: MergeState,
  targetSection: Record<string, Json>,
  contributed: Record<string, Json>,
  selector: MapSelector,
): void {
  for (const [name, version] of Object.entries(contributed)) {
    if (typeof version !== "string" || !version) {
      merge.conflicts.push(`Adjusted ${selector.name}.${name} is not a version string.`);
      continue;
    }
    const existing = targetSection[name];
    if (existing === version) {
      merge.evidence.push(`${name}@${version} already declared in ${selector.name}`);
      continue;
    }
    if (existing !== undefined) {
      merge.conflicts.push(
        `${selector.name}.${name}: target declares ${JSON.stringify(existing)}, contribution requires ${JSON.stringify(version)}. No automatic upgrade.`,
      );
      continue;
    }
    merge.next = edit(merge.next, [selector.name, name], version);
    merge.changed = true;
    merge.evidence.push(`add ${selector.name}.${name}@${version}`);
  }
}

// Literal command chains are the only scripts this handler composes with; a
// script using shell syntax beyond plain "&&" chains needs manual review.
const literalChain = /^[\w .:/\\-]+(?: && [\w .:/\\-]+)*$/;

function programOf(command: string): string {
  return command.split(/\s+/)[0] ?? "";
}

// Compose an existing script with a contributed command: keep it when the
// command already runs, block when the same program is invoked differently
// or the script is not a literal "&&" chain, append otherwise.
function composeScript(merge: MergeState, name: string, existing: string, command: string): void {
  const members = existing.split(" && ");
  if (members.includes(command)) {
    merge.evidence.push(`scripts.${name} already includes the contributed command`);
    return;
  }
  if (members.some((member) => programOf(member) === programOf(command))) {
    merge.conflicts.push(
      `scripts.${name}: target invokes ${programOf(command)} differently; manual composition required.`,
    );
    return;
  }
  if (!literalChain.test(existing)) {
    merge.conflicts.push(
      `scripts.${name}: existing script requires manual composition with the contributed command.`,
    );
    return;
  }
  merge.next = edit(merge.next, ["scripts", name], `${existing} && ${command}`);
  merge.changed = true;
  merge.evidence.push(`append to scripts.${name}`);
}

// Merge contributed scripts by ensuring each contributed command runs as part
// of the target script. This is generic manifest knowledge; which commands a
// setup contributes is recipe opinion.
function mergeScripts(
  merge: MergeState,
  targetScripts: Record<string, Json> | null,
  contributed: Record<string, Json>,
): void {
  for (const [name, command] of Object.entries(contributed)) {
    if (typeof command !== "string" || !command) {
      merge.conflicts.push(`Adjusted scripts.${name} is not a command string.`);
      continue;
    }
    const existing = targetScripts?.[name];
    if (existing === undefined) {
      merge.next = edit(merge.next, ["scripts", name], command);
      merge.changed = true;
      merge.evidence.push(`add scripts.${name}`);
      continue;
    }
    if (typeof existing !== "string") {
      merge.conflicts.push(`scripts.${name}: target value is not a command string.`);
      continue;
    }
    if (existing === command) {
      merge.evidence.push(`scripts.${name} already set`);
      continue;
    }
    composeScript(merge, name, existing, command);
  }
}

// Merge the contributed dependency sections into the target manifest.
function mergeDependencySections(
  merge: MergeState,
  target: ObjectJson,
  contribution: ObjectJson,
): void {
  for (const selector of selectors) {
    const contributed = lookupMap<Json>(contribution, selector);
    if (contributed.state === "absent") continue;
    if (contributed.state === "unsupported") {
      merge.conflicts.push(`Adjusted ${selector.name} is not a keyed map; unsupported structure.`);
      continue;
    }
    const targetSection = lookupMap<Json>(target, selector);
    if (targetSection.state === "unsupported") {
      merge.conflicts.push(`Target ${selector.name} is not a keyed map; unsupported structure.`);
      continue;
    }
    mergeSection(
      merge,
      targetSection.state === "found" ? targetSection.map : {},
      contributed.map,
      selector,
    );
  }
}

// Merge the contributed version/packageManager scalars into the target
// manifest. A missing target value is set with a plain scalar assignment,
// which cannot partially apply; a differing value blocks rather than
// upgrading the project or switching its toolchain underneath review.
function mergeScalarFields(merge: MergeState, target: ObjectJson, contribution: ObjectJson): void {
  for (const field of ["version", "packageManager"]) {
    const value = contribution[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value) {
      merge.conflicts.push(`${field} in the contribution is not a version string.`);
      continue;
    }
    const existing = target[field];
    if (existing === undefined) {
      merge.next = edit(merge.next, [field], value);
      merge.changed = true;
      merge.evidence.push(`set ${field} ${value}`);
      continue;
    }
    if (existing !== value)
      merge.conflicts.push(
        `${field}: target sets ${JSON.stringify(existing)}, contribution requires ${JSON.stringify(value)}. No automatic upgrade.`,
      );
    else merge.evidence.push(`${field} already set`);
  }
}

// Merge the contributed scripts into the target manifest.
function mergeScriptSection(merge: MergeState, target: ObjectJson, contribution: ObjectJson): void {
  const contributedScripts = lookupMap<Json>(contribution, scriptsSelector);
  if (contributedScripts.state === "unsupported")
    merge.conflicts.push("Adjusted scripts is not a keyed map; unsupported structure.");
  if (contributedScripts.state !== "found") return;
  const targetScripts = lookupMap<Json>(target, scriptsSelector);
  if (targetScripts.state === "unsupported")
    merge.conflicts.push("Target scripts is not a keyed map; unsupported structure.");
  else
    mergeScripts(
      merge,
      targetScripts.state === "found" ? targetScripts.map : null,
      contributedScripts.map,
    );
}

async function planApply({
  cwd,
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
  const manifestPath = join(cwd, "package.json");

  const targetText = await read(manifestPath);
  if (targetText === null) {
    // Absent target (the create case): materialize the complete resolved
    // artifact verbatim instead of rebuilding it from understood fields, so
    // native configuration the handler does not model still survives.
    return {
      operations: [{ kind: "write" as const, path: manifestPath, before: null, after: contents }],
      evidence: ["create package.json from the recipe artifact"],
      conflicts,
    };
  }

  const target = json(targetText, "package.json");
  const contribution = json(contents, "adjusted package.json");

  // Contribution coverage: the merge below consumes dependencies,
  // devDependencies, scripts, and the version/packageManager scalars. Any
  // other contributed field whose value differs from the target would be
  // silently ignored, so it blocks loudly instead. Identical values need no
  // application and are reported as evidence. Only `name` always belongs to
  // the target: packed recipes strip it and create stamps it, so the merge
  // never claims it.
  const extra = Object.keys(contribution).filter(
    (field) => !["dependencies", "devDependencies", "scripts", "name"].includes(field),
  );
  const isScalar = (field: string) => field === "version" || field === "packageManager";
  const unsupported = extra.filter(
    (field) => !isScalar(field) && canonical(target[field]) !== canonical(contribution[field]),
  );
  if (unsupported.length) {
    conflicts.push(
      `package.json contribution carries unsupported field(s): ${unsupported.join(", ")}. Only dependencies, devDependencies, scripts, version, and packageManager can be contributed.`,
    );
    return { operations: [], evidence, conflicts };
  }
  for (const field of extra.filter((field) => !isScalar(field)))
    evidence.push(`${field} already matches in package.json`);

  const merge: MergeState = { next: targetText, changed: false, conflicts, evidence };
  mergeDependencySections(merge, target, contribution);
  mergeScriptSection(merge, target, contribution);
  mergeScalarFields(merge, target, contribution);

  const operations = merge.changed
    ? [{ kind: "write" as const, path: manifestPath, before: targetText, after: merge.next }]
    : [];
  return { operations, evidence, conflicts };
}

// Merge one keyed string map across every contribution. Non-map shapes
// fail loudly; identical values dedupe; differing values conflict with both
// contributing instances named. Scripts never compose shell commands
// between recipes: differing commands conflict for this slice.
function combineStringMap(
  state: CombineState,
  contributions: ArtifactContribution[],
  parsed: ObjectJson[],
  field: string,
  noun: string,
  scripts: boolean,
): void {
  const maps: { owner: string; map: Record<string, Json> }[] = [];
  for (const [index, contribution] of contributions.entries()) {
    const lookup = lookupMap<Json>(parsed[index]!, mapField(field));
    if (lookup.state === "absent") continue;
    if (lookup.state === "unsupported") {
      state.conflicts.push(
        `${field} from ${ownerOf(contribution)} is not a keyed map; unsupported structure.`,
      );
      continue;
    }
    const clean = entriesOf(lookup.map, field, noun, ownerOf(contribution), state.conflicts);
    maps.push({ owner: ownerOf(contribution), map: clean });
  }
  const known = unionKeyedMaps(
    maps,
    (name, first, second) =>
      scripts
        ? `${field}.${name}: ${first.owner} contributes ${JSON.stringify(first.value)}, ${second.owner} contributes ${JSON.stringify(second.value)}; composing commands between recipes is unsupported.`
        : `${field}.${name}: ${first.owner} requires ${JSON.stringify(first.value)}, ${second.owner} requires ${JSON.stringify(second.value)}.`,
    state.conflicts,
  );
  mergeKnownEntries(state, [field], parsed[0]![field], known, field);
}

function entriesOf(
  map: Record<string, Json>,
  field: string,
  noun: string,
  owner: string,
  conflicts: string[],
): Record<string, Json> {
  const clean: Record<string, Json> = {};
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== "string" || !value) {
      conflicts.push(`${field}.${name} from ${owner} is not a ${noun}.`);
      continue;
    }
    clean[name] = value;
  }
  return clean;
}

// Merge one string-valued scalar field across every contribution: a lone
// value is preserved, identical values dedupe, differing values conflict.
// Name keeps its target-identity rule — preserved, never reconciled.
function combineScalar(
  state: CombineState,
  contributions: ArtifactContribution[],
  parsed: ObjectJson[],
  field: string,
  noun: string,
): void {
  const values: { owner: string; value: Json | undefined }[] = [];
  for (const [index, contribution] of contributions.entries()) {
    const value = parsed[index]![field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value) {
      state.conflicts.push(`${field} from ${ownerOf(contribution)} is not a ${noun}.`);
      continue;
    }
    values.push({ owner: ownerOf(contribution), value });
  }
  const distinct = unionValues(values);
  if (distinct.length > 1)
    state.conflicts.push(
      `${field}: ${distinct.map((seen) => `${seen.owner} contributes ${JSON.stringify(seen.value)}`).join(", ")}.`,
    );
  else if (distinct.length === 1) placeField(state, field, distinct[0]!.value);
}

// Combine several same-path package.json contributions into one, before any
// target merge runs. Order-independent and lossless: disjoint keys merge,
// canonically identical values dedupe, and every divergence names both
// contributing instances in a conflict. Text surgery on the first
// contribution preserves its formatting; per-key identity makes the merged
// values independent of contribution order.
function combine(contributions: ArtifactContribution[]): CombineResult {
  const parsed = contributions.map((contribution) =>
    json(contribution.contents, `${contribution.path} from ${ownerOf(contribution)}`),
  );
  const state = combineState(contributions[0]!.contents, parsed[0]!);
  for (const selector of selectors)
    combineStringMap(state, contributions, parsed, selector.name, "version string", false);
  combineStringMap(state, contributions, parsed, "scripts", "command string", true);
  combineScalar(state, contributions, parsed, "name", "name string");
  for (const field of ["version", "packageManager"])
    combineScalar(state, contributions, parsed, field, "version string");
  combineExtraFields(
    state,
    contributions,
    parsed,
    new Set(["dependencies", "devDependencies", "scripts", "name", "version", "packageManager"]),
  );
  return {
    contents: state.next,
    evidence: [
      `combined ${contributions.length} contributions from ${contributions.map(ownerOf).join(", ")}`,
    ],
    conflicts: state.conflicts,
  };
}

export const packageManifestHandler: ArtifactHandler = {
  id: "package-manifest",
  handles: (artifactPath) => artifactPath === "package.json",
  adjust,
  validateAdjusted,
  planApply,
  combine,
};
