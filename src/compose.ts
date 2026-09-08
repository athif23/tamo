import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AdjustResult,
  ArtifactContribution,
  ArtifactHandler,
  CombineResult,
  StructuralEdit,
} from "./handler.ts";
import type { CommandOperation, Operation, Plan, Snapshot } from "./plan.ts";
import { fingerprint } from "./plan.ts";
import type { ApplyResult } from "./runtime.ts";
import { planWholeFile } from "./handlers/file.ts";

// Core composition for the bounded artifact-handler experiments (SPEC 0.11).
// Core knows recipes include recipes, that customization records are
// instance-addressed structural edits, and how to order planning fragments;
// it knows nothing about packages, Oxlint rules, or any other artifact
// meaning — all semantics live behind the ArtifactHandler interface, and
// recipe-specific executable behavior lives behind RecipeBehavior.
//
// Recipes here are the minimal in-memory representation the experiments
// need (child include, saved parent customization, invocation
// customization, attached behavior). Durable recipes use this same shape,
// loaded from ~/.tamo/recipes by src/recipes.ts. Recipes and their artifacts
// are immutable inputs: resolution produces adjusted copies and never mutates
// saved state.

export type Artifact = { path: string; contents: string };

// Structured customization identity (SPEC 0.5): the include chain naming the
// instance that owns the artifact, plus the artifact path, selector, and
// entry. Entry names may contain slashes; the structured shape keeps them
// distinct from nesting. `instance` in a recipe's own customizations is
// relative to that recipe; in invocation customizations it is absolute.
export type OmitEdit = {
  op: "omit";
  instance: string[];
  artifact: string;
  selector: string;
  entry: string;
};

// Provisional seam for recipe-carried executable behavior (SPEC 0.11
// experiments). Not a canonized product abstraction: recipes attach at
// most one behavior, `finalize` contributes conflicts/evidence/commands (it
// is type-barred from artifact writes — handlers own those), and `verify`
// checks the applied result against the behavior-owning instance's
// resolved intent. Planning is read-only by contract; this is not a
// sandbox. Precisely: a RecipeBehavior cannot directly author
// WriteOperations; CommandOperations may naturally have external
// filesystem effects when the runtime executes them.
export type RecipeContext = {
  cwd: string;
  instance: string[];
  // The resolved, customized artifacts of this recipe instance.
  artifacts: { path: string; contents: string }[];
  // Target-relative tracked read: every observation is registered into the
  // plan's reviewed inputs automatically.
  read: (path: string) => Promise<string | null>;
  // Explicit tracking for observations made outside target-relative reads
  // (module-resolved binaries, hashes); participates in the same recheck.
  track: (path: string, contents: string | Uint8Array | null) => void;
};

export type RecipeBehavior = {
  // Preparation runs before handler artifact planning, for upstream
  // commands whose generated state must exist first (SPEC 0.8). It sees
  // the instance's resolved, customized contributions and the current
  // target through tracked reads. Like finalize it contributes only
  // conflicts/evidence/commands — never writes. When it returns commands,
  // the planning pass stops there: the preparation plan carries
  // requiresReplan and artifact planning waits for a fresh replan.
  prepare?: (context: RecipeContext) => Promise<BehaviorFragment>;
  finalize?: (context: RecipeContext) => Promise<BehaviorFragment>;
  verify?: (context: {
    cwd: string;
    instance: string[];
    artifacts: { path: string; contents: string }[];
  }) => Promise<string[]>;
};

export type BehaviorFragment = {
  conflicts: string[];
  evidence: string[];
  operations: CommandOperation[];
};

export type Recipe = {
  name: string;
  artifacts: Artifact[];
  includes?: { recipe: string }[];
  customizations?: OmitEdit[];
  behavior?: RecipeBehavior;
  // Absolute path of the recipe-local behavior module, set by the durable
  // loader when the recipe directory carries one. Core imports it
  // demand-first for selected resolution trees; it is never read from
  // recipe.json and never executed remotely.
  behaviorFile?: string;
};

export type ResolvedArtifact = {
  instance: string[];
  path: string;
  contents: string;
  sources: string[];
};

export type Resolution = {
  // One entry per distinct artifact path after same-path combination: the
  // artifacts Core plans. Singletons keep their contributor's identity;
  // combined groups are owned by the composition entry.
  artifacts: ResolvedArtifact[];
  // Every resolved, customized per-instance contribution before
  // combination: the provenance behavior planning and verification read.
  contributions: ResolvedArtifact[];
  // Every recipe instance in the include tree, as absolute instance chains.
  instances: string[][];
  // Combination evidence, path-prefixed by Core.
  evidence: string[];
  conflicts: string[];
};

// Core-owned tracked reads for one planning run: target-relative reads and
// explicit out-of-band observations both register into the reviewed-input
// set that the runtime rechecks before execution.
export type TrackedReads = {
  read: (path: string) => Promise<string | null>;
  track: (path: string, contents: string | Uint8Array | null) => void;
  snapshots: () => Snapshot[];
};

export function trackReads(
  cwd: string,
  read: (path: string) => Promise<string | null>,
): TrackedReads {
  const snapshots = new Map<string, Snapshot>();
  const register = (path: string, contents: string | Uint8Array | null): void => {
    const absolute = resolve(cwd, path);
    if (!snapshots.has(absolute))
      snapshots.set(absolute, { path: absolute, hash: fingerprint(contents) });
  };
  return {
    track: register,
    read: async (path) => {
      const absolute = resolve(cwd, path);
      const contents = await read(absolute);
      register(absolute, contents);
      return contents;
    },
    snapshots: () => [...snapshots.values()],
  };
}

export function formatAddress(edit: OmitEdit): string {
  return `instance [${edit.instance.join(" > ")}] artifact ${edit.artifact} selector ${edit.selector} entry ${edit.entry}`;
}

type PendingEdit = { edit: OmitEdit; source: string };

function sameInstance(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function collectRecipes(
  recipes: Record<string, Recipe>,
  name: string,
  chain: string[],
  artifacts: ResolvedArtifact[],
  instances: string[][],
  pending: PendingEdit[],
  conflicts: string[],
): void {
  if (chain.includes(name)) {
    conflicts.push(`Recipe include cycle: [${[...chain, name].join(" > ")}].`);
    return;
  }
  const recipe = recipes[name];
  if (!recipe) {
    conflicts.push(
      `Unknown recipe: ${name}${chain.length ? ` (included by ${chain[chain.length - 1]})` : ""}.`,
    );
    return;
  }
  const instance = [...chain, name];
  instances.push(instance);
  for (const artifact of recipe.artifacts)
    artifacts.push({ instance, path: artifact.path, contents: artifact.contents, sources: [] });
  // Without aliases the same child cannot be included twice: its instance
  // chain would be ambiguous to customization addresses.
  const seen = new Set<string>();
  for (const include of recipe.includes ?? []) {
    if (seen.has(include.recipe)) {
      conflicts.push(
        `Recipe ${name} includes ${include.recipe} more than once; duplicate includes are unsupported without aliases.`,
      );
      continue;
    }
    seen.add(include.recipe);
    collectRecipes(recipes, include.recipe, instance, artifacts, instances, pending, conflicts);
  }
  for (const customization of recipe.customizations ?? [])
    pending.push({
      edit: { ...customization, instance: [...instance, ...customization.instance] },
      source: `saved:${name}`,
    });
}

function findResolvedArtifact(
  artifacts: ResolvedArtifact[],
  edit: OmitEdit,
): ResolvedArtifact | undefined {
  return artifacts.find(
    (resolved) =>
      resolved.path === edit.artifact &&
      resolved.instance.length === edit.instance.length &&
      resolved.instance.every((segment, index) => segment === edit.instance[index]),
  );
}

// One shared processing path for saved-parent and invocation edits: only
// the address and the source label differ.
function applyEdit(
  edit: OmitEdit,
  source: string,
  artifacts: ResolvedArtifact[],
  handlers: ArtifactHandler[],
  conflicts: string[],
): void {
  if (edit.op !== "omit") {
    // SAFETY: stored JSON bypasses static types, so op can arrive as any JSON value at runtime.
    const op = edit.op as unknown;
    conflicts.push(
      `${formatAddress(edit)}: unsupported customization op ${JSON.stringify(op)}; only "omit" is supported.`,
    );
    return;
  }
  const artifact = findResolvedArtifact(artifacts, edit);
  if (!artifact) {
    conflicts.push(`Stale customization address: ${formatAddress(edit)}.`);
    return;
  }
  const handler = handlers.find((candidate) => candidate.handles(artifact.path));
  if (!handler) {
    conflicts.push(`No handler claims artifact ${artifact.path} (${formatAddress(edit)}).`);
    return;
  }

  let adjusted: AdjustResult;
  try {
    adjusted = handler.adjust(artifact.path, artifact.contents, {
      op: edit.op,
      selector: edit.selector,
      entry: edit.entry,
    } satisfies StructuralEdit);
  } catch (error) {
    conflicts.push(
      `${formatAddress(edit)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (adjusted.conflicts.length) {
    conflicts.push(...adjusted.conflicts.map((conflict) => `${formatAddress(edit)}: ${conflict}`));
    return;
  }
  artifact.contents = adjusted.contents;
  artifact.sources.push(`${source}: omit ${edit.selector}.${edit.entry}`);
}

function validateAdjustedArtifacts(
  artifacts: ResolvedArtifact[],
  handlers: ArtifactHandler[],
  conflicts: string[],
): void {
  for (const artifact of artifacts) {
    const handler = handlers.find((candidate) => candidate.handles(artifact.path));
    if (!handler?.validateAdjusted) continue;
    try {
      conflicts.push(...handler.validateAdjusted(artifact.path, artifact.contents));
    } catch (error) {
      conflicts.push(
        `Invalid adjusted artifact ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// Group customized contributions by artifact path and combine same-path
// groups. Core knows only paths and provenance here: a claiming handler
// with combination support merges the group, unhandled groups deduplicate
// when byte-identical and conflict otherwise. Never last-writer-wins, and
// include order never resolves incompatible values.
type CombinedGroup = { artifact: ResolvedArtifact; evidence: string[]; conflicts: string[] };

function originsOf(group: ResolvedArtifact[]): string {
  return group.map((member) => `[${member.instance.join(" > ")}]`).join(", ");
}

function combineWithHandler(
  entry: string,
  path: string,
  group: ResolvedArtifact[],
  combine: (contributions: ArtifactContribution[]) => CombineResult,
): CombinedGroup {
  const contributions: ArtifactContribution[] = group.map((member) => ({
    instance: member.instance,
    sources: member.sources,
    path: member.path,
    contents: member.contents,
  }));
  let result: CombineResult;
  try {
    result = combine(contributions);
  } catch (error) {
    return {
      artifact: group[0]!,
      evidence: [],
      conflicts: [
        `Combining ${path} from ${originsOf(group)} failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  if (result.conflicts.length)
    return { artifact: group[0]!, evidence: [], conflicts: result.conflicts };
  return {
    artifact: {
      instance: [entry],
      path,
      contents: result.contents,
      sources: group.flatMap((member) => member.sources),
    },
    evidence: result.evidence.map((line) => `${path}: ${line}`),
    conflicts: [],
  };
}

function dedupeIdentical(path: string, group: ResolvedArtifact[]): CombinedGroup {
  const origins = originsOf(group);
  if (group.every((member) => member.contents === group[0]!.contents))
    return {
      artifact: { ...group[0]!, sources: group.flatMap((member) => member.sources) },
      evidence: [`${path}: identical contributions from ${origins} deduplicated`],
      conflicts: [],
    };
  return {
    artifact: group[0]!,
    evidence: [],
    conflicts: [
      `Artifact ${path} is contributed by ${origins} with differing contents; no handler combines them.`,
    ],
  };
}

function combineGroup(
  entry: string,
  path: string,
  group: ResolvedArtifact[],
  handlers: ArtifactHandler[],
): CombinedGroup {
  if (group.length === 1) return { artifact: group[0]!, evidence: [], conflicts: [] };
  const handler = handlers.find((candidate) => candidate.handles(path));
  if (handler?.combine) return combineWithHandler(entry, path, group, handler.combine);
  return dedupeIdentical(path, group);
}

// Resolve the entry recipe's include tree and apply persistent then
// invocation customizations to their specific instances. No combination
// yet: preparation behavior runs against these per-instance contributions
// before same-path groups are merged.
type ContributionResolution = {
  contributions: ResolvedArtifact[];
  instances: string[][];
  conflicts: string[];
};

function resolveContributions(
  recipes: Record<string, Recipe>,
  entry: string,
  invocation: OmitEdit[],
  handlers: ArtifactHandler[],
): ContributionResolution {
  const conflicts: string[] = [];
  const contributions: ResolvedArtifact[] = [];
  const instances: string[][] = [];
  const pending: PendingEdit[] = [];

  collectRecipes(recipes, entry, [], contributions, instances, pending, conflicts);
  for (const edit of invocation) pending.push({ edit, source: "invocation" });
  for (const { edit, source } of pending)
    applyEdit(edit, source, contributions, handlers, conflicts);
  return { contributions, instances, conflicts };
}

// Group customized contributions by artifact path, combine same-path
// groups, and validate the combined result. Incompatible contributions
// are rejected visibly rather than guessed away.
function combineContributions(
  entry: string,
  resolved: ContributionResolution,
  handlers: ArtifactHandler[],
): Resolution {
  const artifacts: ResolvedArtifact[] = [];
  const evidence: string[] = [];
  const conflicts = [...resolved.conflicts];
  if (!conflicts.length) {
    const groups = new Map<string, ResolvedArtifact[]>();
    for (const contribution of resolved.contributions) {
      const path = contribution.path.replaceAll("\\", "/");
      const group = groups.get(path);
      if (group) group.push(contribution);
      else groups.set(path, [contribution]);
    }
    for (const [path, group] of groups) {
      const combined = combineGroup(entry, path, group, handlers);
      artifacts.push(combined.artifact);
      evidence.push(...combined.evidence);
      conflicts.push(...combined.conflicts);
    }
  }
  if (!conflicts.length) validateAdjustedArtifacts(artifacts, handlers, conflicts);

  return {
    artifacts,
    contributions: resolved.contributions,
    instances: resolved.instances,
    evidence,
    conflicts,
  };
}

// Resolve the entry recipe's include tree, apply persistent then invocation
// customizations to their specific instances, combine same-path artifact
// contributions, and validate the combined result. Cycles, missing
// children, stale addresses, and incompatible contributions are rejected
// visibly rather than guessed away.
export function resolveRecipes(
  recipes: Record<string, Recipe>,
  entry: string,
  invocation: OmitEdit[],
  handlers: ArtifactHandler[],
): Resolution {
  return combineContributions(
    entry,
    resolveContributions(recipes, entry, invocation, handlers),
    handlers,
  );
}

// The reviewed preparation Core hands to the runtime: resolved artifacts and
// the reviewed Plan. Verification is a separate Core-owned step
// (verifyComposition) over the same input.
export type CompositionPreparation = {
  artifacts: ResolvedArtifact[];
  plan?: Plan;
  conflicts: string[];
};

export type CompositionInput = {
  cwd: string;
  recipes: Record<string, Recipe>;
  entry: string;
  invocation: OmitEdit[];
  handlers: ArtifactHandler[];
  read: (path: string) => Promise<string | null>;
};

type ArtifactFragment = { conflicts: string[]; evidence: string[]; operations: Operation[] };

// Plan one artifact's contribution: the claiming semantic handler, or —
// when none claims it — Core's conservative whole-file fallback (SPEC 0.7).
// Claim precedence never depends on handler registration order.
async function planArtifact(
  artifact: ResolvedArtifact,
  handlers: ArtifactHandler[],
  tracked: TrackedReads,
  cwd: string,
): Promise<ArtifactFragment> {
  const handler = handlers.find((candidate) => candidate.handles(artifact.path));
  try {
    if (!handler)
      return await planWholeFile({
        cwd,
        artifactPath: artifact.path,
        contents: artifact.contents,
        read: tracked.read,
      });
    const applied = await handler.planApply({
      cwd,
      artifactPath: artifact.path,
      contents: artifact.contents,
      read: tracked.read,
    });
    return {
      conflicts: applied.conflicts,
      evidence: applied.evidence.map(
        (line) => `${artifact.path} (instance [${artifact.instance.join(" > ")}]): ${line}`,
      ),
      operations: applied.operations,
    };
  } catch (error) {
    return {
      conflicts: [
        `Planning ${artifact.path} failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      evidence: [],
      operations: [],
    };
  }
}

// Behavior-bearing instances across the resolved tree, each paired with
// its behavior. Core tracks only instance identity and whether a
// fragment carries commands; command meaning and ordering stay with the
// behaviors. Multiple command-producing instances are an explicit
// blocking conflict — Core never orders commands by traversal.
function behaviorInstances(
  recipes: Record<string, Recipe>,
  resolution: { instances: string[][] },
): string[][] {
  return resolution.instances.filter((instance) => {
    const recipe = recipes[instance[instance.length - 1]!];
    return recipe?.behavior !== undefined;
  });
}

type BehaviorRef = { instance: string[]; behavior: RecipeBehavior };

function behaviorRefs(
  recipes: Record<string, Recipe>,
  resolution: { instances: string[][] },
): BehaviorRef[] {
  const refs: BehaviorRef[] = [];
  for (const instance of behaviorInstances(recipes, resolution)) {
    const behavior = recipes[instance[instance.length - 1]!]!.behavior;
    if (behavior) refs.push({ instance, behavior });
  }
  return refs;
}

function instanceLabel(instance: string[]): string {
  return `[${instance.join(" > ")}]`;
}

// Durable `behavior.mjs` is plain JavaScript, so TypeScript types do not
// protect the runtime boundary: every hook result is validated and
// normalized here, before later planning/runtime code can fail on it
// incidentally. Errors name the recipe/behavior instance, the hook, and
// the offending part of the returned value.
function behaviorWhere(instance: string[], hook: string): string {
  const name = instance.length ? instance[instance.length - 1] : undefined;
  const who = name ? `Recipe '${name}' behavior` : "Recipe behavior";
  return instance.length ? `${who} ${hook} ${instanceLabel(instance)}` : `${who} ${hook}`;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function checkStringArray(value: unknown, field: string, where: string): string[] {
  if (!Array.isArray(value))
    throw new Error(`${where}: ${field} must be an array of strings, got ${describeValue(value)}.`);
  for (const [index, entry] of value.entries())
    if (typeof entry !== "string")
      throw new Error(
        `${where}: ${field}[${index}] must be a string, got ${describeValue(entry)}.`,
      );
  return [...value];
}

const commandOperationFields: readonly string[] = ["kind", "executable", "args", "cwd", "purpose"];

function checkCommandOperation(value: unknown, index: number, where: string): CommandOperation {
  const at = `${where}: operations[${index}]`;
  if (!isPlainObject(value))
    throw new Error(`${at} must be a command operation object, got ${describeValue(value)}.`);
  if (value.kind === "write")
    throw new Error(
      `${at} is a write operation; prepare/finalize may only contribute command operations — they cannot directly write artifacts.`,
    );
  if (value.kind !== "command")
    throw new Error(
      `${at} must be a command operation with kind "command", got ${JSON.stringify(value.kind)}.`,
    );
  const unknownKeys = Object.keys(value).filter((key) => !commandOperationFields.includes(key));
  if (unknownKeys.length)
    throw new Error(
      `${at} carries unknown key(s): ${unknownKeys.join(", ")}. Allowed: ${commandOperationFields.join(", ")}.`,
    );
  if (typeof value.executable !== "string" || !value.executable)
    throw new Error(
      `${at} executable must be a non-empty string, got ${describeValue(value.executable)}.`,
    );
  if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))
    throw new Error(`${at} args must be an array of strings, got ${describeValue(value.args)}.`);
  if (typeof value.cwd !== "string" || !value.cwd)
    throw new Error(`${at} cwd must be a non-empty string, got ${describeValue(value.cwd)}.`);
  if (typeof value.purpose !== "string" || !value.purpose)
    throw new Error(
      `${at} purpose must be a non-empty string, got ${describeValue(value.purpose)}.`,
    );
  return {
    kind: "command",
    executable: value.executable,
    args: [...value.args],
    cwd: value.cwd,
    purpose: value.purpose,
  };
}

function checkOperationsArray(value: unknown, where: string): CommandOperation[] {
  if (!Array.isArray(value))
    throw new Error(`${where}: operations must be an array, got ${describeValue(value)}.`);
  return value.map((operation, index) => checkCommandOperation(operation, index, where));
}

const fragmentFields: readonly string[] = ["conflicts", "evidence", "operations"];

// Validate and normalize one prepare/finalize hook result into the internal
// BehaviorFragment Core already uses: undefined or {} means no procedural
// work, omitted fields default to empty, and anything malformed fails loudly
// here instead of later planning/runtime code.
export function checkBehaviorFragment(
  instance: string[],
  hook: "prepare" | "finalize",
  result: unknown,
): BehaviorFragment {
  const where = behaviorWhere(instance, hook);
  if (result === undefined) return { conflicts: [], evidence: [], operations: [] };
  if (!isPlainObject(result))
    throw new Error(
      `${where}: result must be undefined or a plain object with only conflicts/evidence/operations, got ${describeValue(result)}.`,
    );
  const unknownKeys = Object.keys(result).filter((key) => !fragmentFields.includes(key));
  if (unknownKeys.length)
    throw new Error(
      `${where}: result carries unknown key(s): ${unknownKeys.join(", ")}. Allowed: ${fragmentFields.join(", ")}.`,
    );
  return {
    conflicts:
      result.conflicts === undefined ? [] : checkStringArray(result.conflicts, "conflicts", where),
    evidence:
      result.evidence === undefined ? [] : checkStringArray(result.evidence, "evidence", where),
    operations:
      result.operations === undefined ? [] : checkOperationsArray(result.operations, where),
  };
}

// Validate one verify hook result: undefined and [] both mean success,
// otherwise the result must be an array of failure strings.
export function checkVerifyResult(instance: string[], result: unknown): string[] {
  const where = behaviorWhere(instance, "verify");
  if (result === undefined) return [];
  if (!Array.isArray(result))
    throw new Error(
      `${where}: result must be undefined or an array of strings, got ${describeValue(result)}.`,
    );
  for (const [index, entry] of result.entries())
    if (typeof entry !== "string")
      throw new Error(
        `${where}: failures[${index}] must be a string, got ${describeValue(entry)}.`,
      );
  return [...result];
}

const BEHAVIOR_HOOKS = ["prepare", "finalize", "verify"] as const;

// Validate a behavior module's default export at the loading boundary.
// Exactly one RecipeBehavior value, no more: unknown keys, non-callable
// hooks, and hookless exports all fail loudly instead of silently
// degrading the composition they belong to.
function checkBehaviorExport(
  name: string,
  exported: unknown,
): { behavior?: RecipeBehavior; conflicts: string[] } {
  const where = `Recipe '${name}' behavior`;
  if (exported === undefined)
    return { conflicts: [`${where} must default-export a behavior object.`] };
  if (typeof exported !== "object" || exported === null || Array.isArray(exported))
    return { conflicts: [`${where} must default-export a behavior object.`] };
  // SAFETY: the guard above narrowed the export to a non-array object.
  const candidate = exported as Record<string, unknown>;
  const allowed: readonly string[] = BEHAVIOR_HOOKS;
  const unknownKeys = Object.keys(candidate).filter((key) => !allowed.includes(key));
  if (unknownKeys.length)
    return {
      conflicts: [
        `${where} exports unknown key(s): ${unknownKeys.join(", ")}. Allowed: ${BEHAVIOR_HOOKS.join(", ")}.`,
      ],
    };
  const behavior: RecipeBehavior = {};
  for (const hook of BEHAVIOR_HOOKS) {
    const fn = candidate[hook];
    if (fn === undefined) continue;
    if (typeof fn !== "function")
      return { conflicts: [`${where} hook '${hook}' is not callable.`] };
    if (hook === "prepare") {
      // SAFETY: typeof narrowing just established callability of the prepare hook.
      behavior.prepare = fn as RecipeBehavior["prepare"];
    } else if (hook === "finalize") {
      // SAFETY: typeof narrowing just established callability of the finalize hook.
      behavior.finalize = fn as RecipeBehavior["finalize"];
    } else {
      // SAFETY: typeof narrowing just established callability of the verify hook.
      behavior.verify = fn as RecipeBehavior["verify"];
    }
  }
  if (Object.keys(behavior).length === 0)
    return {
      conflicts: [
        `${where} exports no hooks. Expected at least one of: ${BEHAVIOR_HOOKS.join(", ")}.`,
      ],
    };
  return { behavior, conflicts: [] };
}

// Import behavior modules demand-first: only for recipe names in the
// selected resolution tree, never eagerly for the whole home. Returns a
// bound record copy — callers' records stay immutable — and tracks each
// imported file as a reviewed input so edits between review and execution
// fail the recheck. Unrelated broken recipes are never touched.
async function bindTreeBehaviors(
  recipes: Record<string, Recipe>,
  instances: string[][],
  tracked?: TrackedReads,
): Promise<{ recipes: Record<string, Recipe>; conflicts: string[] }> {
  const bound = { ...recipes };
  const conflicts: string[] = [];
  for (const name of new Set(instances.flat())) {
    const recipe = bound[name];
    if (!recipe?.behaviorFile || recipe.behavior) continue;
    if (tracked) await tracked.read(recipe.behaviorFile);
    let namespace: Record<string, unknown>;
    try {
      namespace = await import(pathToFileURL(recipe.behaviorFile).href);
    } catch (error) {
      conflicts.push(
        `Recipe '${name}' behavior failed to load: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const checked = checkBehaviorExport(name, namespace.default);
    if (checked.conflicts.length) {
      conflicts.push(...checked.conflicts);
      continue;
    }
    bound[name] = { ...recipe, behavior: checked.behavior };
  }
  return { recipes: bound, conflicts };
}

type BehaviorOutput = { instance: string[]; fragment: BehaviorFragment };

// Name every command-producing instance, sorted so the message never
// depends on traversal order.
function producerConflict(producers: BehaviorOutput[], phase: string): string {
  const names = producers
    .map((output) => instanceLabel(output.instance))
    .sort()
    .join(", ");
  return `Multiple behavior-bearing recipe instances (${names}) planned ${phase} commands; ${phase} command order is unsupported.`;
}

// Plan a behavior-bearing instance's preparation hook against that
// instance's resolved, customized contributions — before same-path
// combination, so upstream commands are planned before handlers observe
// their output. Errors become conflicts; the behavior never throws past
// Core.
async function planPrepare(
  behavior: RecipeBehavior,
  instance: string[],
  resolved: ContributionResolution,
  tracked: TrackedReads,
  cwd: string,
): Promise<BehaviorFragment> {
  if (!behavior.prepare) return { conflicts: [], evidence: [], operations: [] };
  const instanceArtifacts = resolved.contributions
    .filter((artifact) => sameInstance(artifact.instance, instance))
    .map(({ path, contents }) => ({ path, contents }));
  try {
    return checkBehaviorFragment(
      instance,
      "prepare",
      await behavior.prepare({
        cwd,
        instance,
        artifacts: instanceArtifacts,
        read: tracked.read,
        track: tracked.track,
      }),
    );
  } catch (error) {
    return {
      conflicts: [
        `Recipe behavior preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      evidence: [],
      operations: [],
    };
  }
}

// Finalize every behavior-bearing instance's attached behavior against
// its own resolved artifacts. Null fragments (no finalize hook) are
// skipped; command meaning stays with the behaviors.
async function finalizeBehaviors(
  refs: BehaviorRef[],
  resolution: Resolution,
  tracked: TrackedReads,
  cwd: string,
): Promise<BehaviorOutput[]> {
  const outputs: BehaviorOutput[] = [];
  for (const ref of refs) {
    const fragment = await finalizeBehavior(ref.behavior, ref.instance, resolution, tracked, cwd);
    if (fragment) outputs.push({ instance: ref.instance, fragment });
  }
  return outputs;
}

// Finalize a behavior-bearing instance's attached behavior against that
// instance's resolved artifacts. Errors become conflicts; the behavior
// never throws past Core.
//
// Planning invariant: finalize() contributes operations that EXECUTE after
// artifact writes, but the hook itself is evaluated while the final Plan
// is being constructed — same-Plan writes do not exist on disk yet. A
// finalize hook must therefore never require its own Plan's artifact
// writes to already be on disk. It may reason from current target state,
// its own resolved/customized recipe artifacts, state produced by previous
// preparation checkpoints, and state/effects of its own procedural work.
async function finalizeBehavior(
  behavior: RecipeBehavior,
  instance: string[],
  resolution: Resolution,
  tracked: TrackedReads,
  cwd: string,
): Promise<BehaviorFragment | null> {
  if (!behavior.finalize) return null;
  // Behavior reads its own instance's resolved, customized contributions —
  // never the combined artifact shared with sibling instances.
  const instanceArtifacts = resolution.contributions
    .filter((artifact) => sameInstance(artifact.instance, instance))
    .map(({ path, contents }) => ({ path, contents }));
  try {
    return checkBehaviorFragment(
      instance,
      "finalize",
      await behavior.finalize({
        cwd,
        instance,
        artifacts: instanceArtifacts,
        read: tracked.read,
        track: tracked.track,
      }),
    );
  } catch (error) {
    return {
      conflicts: [
        `Recipe behavior planning failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      evidence: [],
      operations: [],
    };
  }
}

// Core-owned verification for a composed recipe: replan-based incompleteness
// checking plus the behavior-owning instance's own verification against its
// resolved intent. This is a plain Core function over the same
// CompositionInput — not a pluggable validator object. Call it after
// runtime execution (or on an
// already-applied target) to complete the
// resolve -> plan -> review -> execute -> verify flow.
export async function verifyComposition(input: CompositionInput): Promise<string[]> {
  const replan = await planComposition(input);
  if (replan.conflicts.length) return replan.conflicts;
  if (replan.plan && replan.plan.operations.length)
    return ["Composition is incomplete; replanning still proposes changes."];

  const resolution = resolveRecipes(input.recipes, input.entry, input.invocation, input.handlers);
  if (resolution.conflicts.length) return resolution.conflicts;
  // Verification binds the same selected tree: behavior files are already
  // imported (and snapshotted) by planning in one process, and a fresh
  // process imports them here instead. Unrelated recipes stay untouched.
  const bound = await bindTreeBehaviors(input.recipes, resolution.instances);
  if (bound.conflicts.length) return bound.conflicts;
  // Every behavior-bearing instance verifies against its own resolved
  // intent — never combined sibling artifacts. Verifiers run one after
  // another in resolution order; a failure in one does not skip the rest.
  // Order here is execution sequence, not workflow precedence.
  const failures: string[] = [];
  for (const ref of behaviorRefs(bound.recipes, resolution)) {
    if (!ref.behavior.verify) continue;
    try {
      failures.push(
        ...checkVerifyResult(
          ref.instance,
          await ref.behavior.verify({
            cwd: input.cwd,
            instance: ref.instance,
            artifacts: resolution.contributions
              .filter((artifact) => sameInstance(artifact.instance, ref.instance))
              .map(({ path, contents }) => ({ path, contents })),
          }),
        ),
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}

// Resolve the composition and plan its contribution into an existing target
// project. A preparation hook runs before combination: when it returns
// commands, this pass plans only that preparation stage (requiresReplan)
// and artifact planning waits for a fresh replan. Otherwise handlers and
// recipe behavior produce planning fragments first; only when no blocking
// conflict exists anywhere are operations assembled — artifact writes
// first, behavior commands afterward — so a blocked plan has zero
// operations by construction. Nothing is written during planning.
export async function planComposition(input: CompositionInput): Promise<CompositionPreparation> {
  const { cwd, recipes, entry, invocation, handlers, read } = input;
  const tracked = trackReads(cwd, read);
  const partial = resolveContributions(recipes, entry, invocation, handlers);
  if (partial.conflicts.length) return { artifacts: [], conflicts: partial.conflicts };

  // Demand-first behavior binding: only the selected tree's modules are
  // imported, so an unrelated broken recipe never blocks this composition.
  const bound = await bindTreeBehaviors(recipes, partial.instances, tracked);
  if (bound.conflicts.length) return { artifacts: [], conflicts: bound.conflicts };
  const refs = behaviorRefs(bound.recipes, partial);

  const staged = await preparationPlan(entry, refs, partial, tracked, cwd);
  if (staged.conflicts.length)
    return { artifacts: partial.contributions, conflicts: staged.conflicts };
  if (staged.plan) return { artifacts: partial.contributions, plan: staged.plan, conflicts: [] };

  const resolution = combineContributions(entry, partial, handlers);
  if (resolution.conflicts.length)
    return { artifacts: resolution.artifacts, conflicts: resolution.conflicts };

  const artifactFragments = [];
  for (const artifact of resolution.artifacts)
    artifactFragments.push(await planArtifact(artifact, handlers, tracked, cwd));
  const behaviorOutputs = await finalizeBehaviors(refs, resolution, tracked, cwd);

  const producers = behaviorOutputs.filter((output) => output.fragment.operations.length > 0);
  const conflicts = [
    ...artifactFragments.flatMap((fragment) => fragment.conflicts),
    ...behaviorOutputs.flatMap((output) => output.fragment.conflicts),
    ...(producers.length > 1 ? [producerConflict(producers, "post-artifact")] : []),
  ];
  if (conflicts.length) return { artifacts: resolution.artifacts, conflicts };

  const plan = assembleFinalPlan(
    entry,
    cwd,
    tracked,
    resolution,
    artifactFragments,
    behaviorOutputs.flatMap((output) => output.fragment.evidence),
    producers.length === 1 ? producers[0]!.fragment.operations : [],
  );
  return { artifacts: resolution.artifacts, plan, conflicts: [] };
}

// Run every behavior-bearing instance's preparation hook and decide the
// pass. Any conflict blocks with zero operations. Silence from all hooks
// continues to combination and artifact planning. Exactly one
// command-producing instance yields the preparation-only plan; more than
// one is an explicit conflict — Core never orders preparation commands.
async function preparationPlan(
  entry: string,
  refs: BehaviorRef[],
  partial: ContributionResolution,
  tracked: TrackedReads,
  cwd: string,
): Promise<{ plan?: Plan; conflicts: string[] }> {
  const outputs: { instance: string[]; fragment: BehaviorFragment }[] = [];
  for (const ref of refs)
    outputs.push({
      instance: ref.instance,
      fragment: await planPrepare(ref.behavior, ref.instance, partial, tracked, cwd),
    });
  const conflicts = outputs.flatMap((output) => output.fragment.conflicts);
  if (conflicts.length) return { conflicts };
  const producers = outputs.filter((output) => output.fragment.operations.length > 0);
  if (producers.length === 0) return { conflicts: [] };
  if (producers.length > 1) return { conflicts: [producerConflict(producers, "preparation")] };
  const preparation = producers[0]!.fragment;
  return {
    plan: {
      subject: `recipe:${entry}`,
      cwd,
      inputs: tracked.snapshots(),
      evidence: outputs.flatMap((output) => output.fragment.evidence),
      conflicts: [],
      operations: preparation.operations,
      validation: [
        "Replan after preparation: execution changes project state that handlers have not observed",
      ],
      requiresReplan: true,
    },
    conflicts: [],
  };
}

// Assemble the final plan once every fragment planned cleanly: artifact
// writes first, then the single command-producing behavior's commands if
// any. Evidence from all behavior fragments is preserved either way.
function assembleFinalPlan(
  entry: string,
  cwd: string,
  tracked: TrackedReads,
  resolution: Resolution,
  artifactFragments: ArtifactFragment[],
  behaviorEvidence: string[],
  behaviorOperations: CommandOperation[],
): Plan {
  return {
    subject: `recipe:${entry}`,
    cwd,
    inputs: tracked.snapshots(),
    evidence: [
      ...resolution.evidence,
      ...artifactFragments.flatMap((fragment) => fragment.evidence),
      ...behaviorEvidence,
    ],
    conflicts: [],
    operations: [
      ...artifactFragments.flatMap((fragment) => fragment.operations),
      ...behaviorOperations,
    ],
    validation: ["Check contributed entries are present in the target artifacts"],
    requiresReplan: false,
  };
}

// One fresh plan with the input it was reviewed against, for verification.
export type FreshPlan = { input?: CompositionInput; plan?: Plan; conflicts: string[] };

// Callbacks for the single preparation checkpoint: plan again from scratch,
// review each plan before execution, execute reviewed plans, verify the
// final application. Core owns the order; the caller owns rendering,
// confirmation, execution, and verification.
export type ReplanRunner = {
  planFresh: () => Promise<FreshPlan>;
  review: (plan: Plan, isPreparation: boolean) => Promise<boolean>;
  execute: (plan: Plan) => Promise<ApplyResult>;
  verify: (input: CompositionInput) => Promise<string[]>;
};

export type ApplyOutcome =
  | { status: "blocked"; conflicts: string[] }
  | { status: "aborted" }
  | { status: "failed"; plan: Plan; result: ApplyResult; verifyErrors: string[] }
  | { status: "applied"; completed: { plan: Plan; result: ApplyResult }[] };

// Apply a recipe plan that may require one preparation checkpoint: review
// and execute the first plan; when it requires a replan, plan again from
// fresh state and review and execute the final plan the same way. A failed
// or declined plan stops the sequence with its own result — no second pass,
// no rollback — and a second preparation plan blocks instead of looping.
export async function applyRecipeWithReplan(runner: ReplanRunner): Promise<ApplyOutcome> {
  const first = await runner.planFresh();
  if (first.conflicts.length || !first.plan || !first.input)
    return { status: "blocked", conflicts: first.conflicts };
  const prepared = first.plan;
  if (!(await runner.review(prepared, prepared.requiresReplan))) return { status: "aborted" };
  const firstResult = await runner.execute(prepared);
  if (firstResult.status !== "applied")
    return { status: "failed", plan: prepared, result: firstResult, verifyErrors: [] };
  if (!prepared.requiresReplan) {
    const verifyErrors = await runner.verify(first.input);
    if (verifyErrors.length)
      return { status: "failed", plan: prepared, result: firstResult, verifyErrors };
    return { status: "applied", completed: [{ plan: prepared, result: firstResult }] };
  }
  const second = await runner.planFresh();
  if (second.conflicts.length || !second.plan || !second.input)
    return { status: "blocked", conflicts: second.conflicts };
  const final = second.plan;
  if (final.requiresReplan)
    return {
      status: "blocked",
      conflicts: [
        "Preparation did not settle after one replan; this experiment supports a single preparation checkpoint.",
      ],
    };
  if (!(await runner.review(final, false))) return { status: "aborted" };
  const finalResult = await runner.execute(final);
  if (finalResult.status !== "applied")
    return { status: "failed", plan: final, result: finalResult, verifyErrors: [] };
  const verifyErrors = await runner.verify(second.input);
  if (verifyErrors.length)
    return { status: "failed", plan: final, result: finalResult, verifyErrors };
  return {
    status: "applied",
    completed: [
      { plan: prepared, result: firstResult },
      { plan: final, result: finalResult },
    ],
  };
}
