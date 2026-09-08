import { canonical, edit, type Json, type ObjectJson } from "./jsonc.ts";
import type { ArtifactContribution } from "./handler.ts";

// Structural helpers for keyed/map selectors (SPEC 0.5). They provide the
// shared inventory and edit mechanics handler authors would otherwise
// reimplement: selectors are named and addressable, and entry values stay
// generic — version strings, rule severities, and richer native
// representations are all opaque here, because their meaning belongs to
// handlers, never to Core or these helpers. Same-path contribution
// combination mechanics live here too: Core groups contributions by path
// and handlers merge them through these order-independent primitives —
// disjoint keys merge, canonically identical values dedupe, divergences
// report through caller-supplied messages, never resolved silently.
export type MapSelector = { kind: "map"; name: string };

export function mapField(name: string): MapSelector {
  return { kind: "map", name };
}

export type MapLookup<T = unknown> =
  | { state: "absent" }
  | { state: "unsupported" }
  | { state: "found"; map: Record<string, T> };

// Locate a map-shaped selector inside a decoded artifact. Absence of the
// selector and presence of a non-map value are distinct outcomes: the first
// is a stale selector reference, the second an unsupported structure. Entry
// values stay generic; a caller that knows its artifact's value shape (for
// example JSON) narrows it with the type argument.
export function lookupMap<T = unknown>(
  artifact: Record<string, unknown>,
  selector: MapSelector,
): MapLookup<T> {
  const value = artifact[selector.name];
  if (value === undefined) return { state: "absent" };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { state: "unsupported" };
  // SAFETY: the guard above narrowed value to a non-array object; the caller's
  // type argument states the entry-value shape it decoded the artifact from.
  return { state: "found", map: value as Record<string, T> };
}

// Names of the entries a map currently exposes, for derived inventory.
export function mapEntries(map: Record<string, unknown>): string[] {
  return Object.keys(map);
}

// Omit validation for keyed maps. Omitting an absent entry is a stale
// reference and fails visibly rather than silently no-oping (SPEC 0.6, 0.11).
export function omitEntry(map: Record<string, unknown>, entry: string): { conflict?: string } {
  if (!(entry in map)) return { conflict: `Entry "${entry}" is not present in the map.` };
  return {};
}

// ---- same-path contribution combination ----

// One owned value in a combination: the recipe instance behind it plus the
// native value. Values stay generic Json; their meaning belongs to the
// calling handler.
export type ContributionOwner = { owner: string; value: Json };

export function ownerOf(contribution: ArtifactContribution): string {
  return `[${contribution.instance.join(" > ")}]`;
}

// Working state for one combination: the text under surgery, its decoded
// view kept in sync, and the conflicts collected along the way.
export type CombineState = { next: string; merged: ObjectJson; conflicts: string[] };

export function combineState(contents: string, parsed: ObjectJson): CombineState {
  return { next: contents, merged: { ...parsed }, conflicts: [] };
}

// Place one top-level field unless the merged view already carries the
// canonically identical value.
export function placeField(state: CombineState, field: string, value: Json): void {
  if (canonical(state.merged[field]) === canonical(value)) return;
  state.next = edit(state.next, [field], value);
  state.merged[field] = value;
}

// Collect the distinct value each key takes across owned maps, keeping the
// first owner per key. Divergences are reported through onDiffer with both
// owners named — never resolved.
export function unionKeyedMaps(
  maps: { owner: string; map: Record<string, Json> }[],
  onDiffer: (key: string, first: ContributionOwner, second: ContributionOwner) => string,
  conflicts: string[],
): Map<string, ContributionOwner> {
  const known = new Map<string, ContributionOwner>();
  for (const { owner, map } of maps)
    for (const [key, value] of Object.entries(map)) {
      const seen = known.get(key);
      if (seen === undefined) {
        known.set(key, { owner, value });
        continue;
      }
      if (canonical(seen.value) !== canonical(value))
        conflicts.push(onDiffer(key, seen, { owner, value }));
    }
  return known;
}

// Collect the distinct defined values across owned values, keeping the
// first owner per canonically identical value.
export function unionValues(
  values: { owner: string; value: Json | undefined }[],
): ContributionOwner[] {
  const distinct: ContributionOwner[] = [];
  for (const { owner, value } of values) {
    if (value === undefined) continue;
    if (distinct.some((seen) => canonical(seen.value) === canonical(value))) continue;
    distinct.push({ owner, value });
  }
  return distinct;
}

// A plain-object copy of a decoded map field, for tracking text surgery.
export function shadowMap(value: Json | undefined): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const shadow: Record<string, Json> = {};
  for (const [key, entry] of Object.entries(value)) shadow[key] = entry;
  return shadow;
}

// Write every collected entry into the text under the key prefix unless the
// base record already carries the canonically identical value, and record
// the result in the merged view.
export function mergeKnownEntries(
  state: CombineState,
  prefix: (string | number)[],
  base: Json | undefined,
  known: Map<string, ContributionOwner>,
  field: string,
): void {
  const shadow = shadowMap(base);
  for (const [key, { value }] of known) {
    if (canonical(shadow[key]) === canonical(value)) continue;
    state.next = edit(state.next, [...prefix, key], value);
    shadow[key] = value;
  }
  if (known.size) state.merged[field] = shadow;
}

// Any top-level field outside the handler's consumed set survives when
// unique or canonically identical, and conflicts explicitly otherwise.
export function combineExtraFields(
  state: CombineState,
  contributions: ArtifactContribution[],
  parsed: ObjectJson[],
  consumed: Set<string>,
): void {
  const fields: string[] = [];
  for (const record of parsed)
    for (const field of Object.keys(record))
      if (!consumed.has(field) && !fields.includes(field)) fields.push(field);
  for (const field of fields) {
    const distinct = unionValues(
      contributions.map((contribution, index) => ({
        owner: ownerOf(contribution),
        value: parsed[index]![field],
      })),
    );
    if (distinct.length > 1)
      state.conflicts.push(
        `${field} differs between ${distinct.map((seen) => seen.owner).join(" and ")}; unsupported composition.`,
      );
    else if (distinct.length === 1) placeField(state, field, distinct[0]!.value);
  }
}
