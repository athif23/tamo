import { lstat, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Artifact, OmitEdit, Recipe } from "./compose.ts";
import { fingerprint, type Snapshot } from "./plan.ts";
import { entryType, listDirectory, read, write } from "./runtime.ts";

// Durable recipe storage: one directory per recipe under the Tamo home.
// recipe.json carries only Tamo-specific composition metadata (child
// includes plus persistent omit customizations) and must stay free of
// native configuration. An optional behavior.mjs beside it attaches
// executable Behavior — trusted local executable code, imported and
// executed during planning (before operation confirmation) and imported
// demand-first by Core.
// artifacts/ mirrors target-relative native paths, so
// artifact identity needs no mapping table: the relative path IS the
// identity Core and the handlers already use. There is no migration from
// ~/.tamo/presets and no dual-format reader; old local state is left
// untouched on disk and simply no longer read.

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function recipeDir(home: string, name: string): string {
  return join(home, "recipes", name);
}

function recipeJsonPath(home: string, name: string): string {
  return join(recipeDir(home, name), "recipe.json");
}

function artifactsDir(home: string, name: string): string {
  return join(recipeDir(home, name), "artifacts");
}

// The single supported behavior module filename. Presence beside
// recipe.json means the recipe has Behavior; absence means artifact-only.
// The name is fixed — never read from recipe.json, never resolved
// remotely — so no path in stored data can redirect the import.
export const BEHAVIOR_FILENAME = "behavior.mjs";

function behaviorPath(home: string, name: string): string {
  return join(recipeDir(home, name), BEHAVIOR_FILENAME);
}

function checkName(name: string, source: string): void {
  if (!namePattern.test(name))
    throw new Error(`Recipe name must match ${namePattern.source}: ${source}`);
}

// Stored artifact paths must stay inside the recipe's artifacts tree, just
// as seed paths must stay inside the project at pack time.
function checkArtifactPath(path: string, source: string): void {
  const normalized = path.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    normalized.split("/").includes("")
  )
    throw new Error(`Recipe artifact paths must stay inside artifacts/: ${path} (${source})`);
}

export async function saveRecipe(
  home: string,
  name: string,
  artifacts: Artifact[],
): Promise<string> {
  checkName(name, `save ${name}`);
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    checkArtifactPath(artifact.path, `save ${name}`);
    if (seen.has(artifact.path)) throw new Error(`Duplicate artifact path: ${artifact.path}`);
    seen.add(artifact.path);
  }
  // Repack rebuilds from the current project: clear the directory first so
  // artifacts deselected since the last pack do not linger as stale files.
  await rm(recipeDir(home, name), { recursive: true, force: true });
  await write(recipeJsonPath(home, name), "{}\n");
  for (const artifact of artifacts)
    await write(join(artifactsDir(home, name), artifact.path), artifact.contents);
  return recipeDir(home, name);
}

async function collectArtifactFiles(directory: string, base: string): Promise<string[]> {
  const entries = (await listDirectory(directory))?.sort() ?? [];
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry);
    if ((await entryType(absolute)) === "directory")
      files.push(...(await collectArtifactFiles(absolute, base)));
    else files.push(relative(base, absolute).replaceAll("\\", "/"));
  }
  return files;
}

export type LoadedRecipe = {
  recipe?: Recipe;
  // Reviewed-input snapshots covering every stored file, so a recipe edited
  // between review and execution fails the recheck instead of applying stale.
  snapshots: Snapshot[];
  conflicts: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Durable composition metadata. `includes` holds child references (no
// aliases; duplicate children are rejected by Core resolution, which owns
// instance identity); `customizations` holds persistent omit edits in
// exactly the in-memory shape. Anything else fails loudly so no intent is
// silently ignored — and native configuration can never hide here, because
// no field carries values, only addresses.
function readIncludes(value: Record<string, unknown>, jsonPath: string): { recipe: string }[] {
  if (value.includes === undefined) return [];
  if (!Array.isArray(value.includes))
    throw new Error(`Recipe includes must be an array: ${jsonPath}`);
  return value.includes.map((entry) => {
    if (!isRecord(entry) || !nonEmptyString(entry.recipe) || Object.keys(entry).length !== 1)
      throw new Error(`Recipe includes entries must be exactly { "recipe": name }: ${jsonPath}`);
    return { recipe: entry.recipe };
  });
}

function readCustomizations(
  value: Record<string, unknown>,
  jsonPath: string,
): { op: "omit"; instance: string[]; artifact: string; selector: string; entry: string }[] {
  if (value.customizations === undefined) return [];
  if (!Array.isArray(value.customizations))
    throw new Error(`Recipe customizations must be an array: ${jsonPath}`);
  return value.customizations.map((edit, index) => {
    const where = `${jsonPath} customizations[${index}]`;
    if (!isRecord(edit)) throw new Error(`Recipe customization must be an object: ${where}`);
    const keys = Object.keys(edit).sort();
    if (
      JSON.stringify(keys) !== JSON.stringify(["artifact", "entry", "instance", "op", "selector"])
    )
      throw new Error(
        `Recipe customization must hold exactly op, instance, artifact, selector, entry: ${where}`,
      );
    if (edit.op !== "omit")
      throw new Error(
        `Unsupported customization op "${String(edit.op)}"; only "omit" is supported: ${where}`,
      );
    if (
      !Array.isArray(edit.instance) ||
      edit.instance.length === 0 ||
      !edit.instance.every(nonEmptyString)
    )
      throw new Error(`Recipe customization instance must be a non-empty string array: ${where}`);
    for (const field of ["artifact", "selector", "entry"] as const)
      if (!nonEmptyString(edit[field]))
        throw new Error(`Recipe customization ${field} must be a non-empty string: ${where}`);
    // SAFETY: the guards above established the exact keys and value shapes.
    return {
      op: "omit" as const,
      instance: edit.instance as string[],
      artifact: edit.artifact as string,
      selector: edit.selector as string,
      entry: edit.entry as string,
    };
  });
}

// recipe.json validation. Throws with the conflict text; unknown fields fail
// loudly instead of being silently ignored.
async function readRecipeDocument(
  home: string,
  name: string,
): Promise<{ text: string; includes: { recipe: string }[]; customizations: OmitEdit[] }> {
  const jsonPath = recipeJsonPath(home, name);
  const text = await read(jsonPath);
  if (text === null) throw new Error(`Recipe is missing recipe.json: ${jsonPath}`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Recipe is not valid JSON: ${jsonPath}`);
  }
  if (!isRecord(value)) throw new Error(`Recipe must be a JSON object: ${jsonPath}`);
  for (const key of Object.keys(value))
    if (key !== "includes" && key !== "customizations")
      throw new Error(`Unknown recipe key "${key}" in ${jsonPath}.`);
  return {
    text,
    includes: readIncludes(value, jsonPath),
    customizations: readCustomizations(value, jsonPath),
  };
}

async function readRecipeArtifacts(
  home: string,
  name: string,
): Promise<{ artifacts: Artifact[]; snapshots: Snapshot[] }> {
  const directory = artifactsDir(home, name);
  const artifacts: Artifact[] = [];
  const snapshots: Snapshot[] = [];
  for (const path of await collectArtifactFiles(directory, directory)) {
    checkArtifactPath(path, recipeJsonPath(home, name));
    const absolute = join(directory, path);
    const contents = await read(absolute);
    if (contents === null) throw new Error(`Recipe artifact disappeared: ${absolute}`);
    snapshots.push({ path: absolute, hash: fingerprint(contents) });
    artifacts.push({ path, contents });
  }
  return { artifacts, snapshots };
}

// Load every recipe in the home into one record for Core resolution, which
// owns cycle/missing-child detection. A single unreadable recipe blocks the
// record with its conflict rather than being silently skipped.
export async function loadAllRecipes(home: string): Promise<{
  recipes: Record<string, Recipe>;
  snapshots: Snapshot[];
  conflicts: string[];
}> {
  const names = ((await listDirectory(join(home, "recipes"))) ?? []).sort();
  const recipes: Record<string, Recipe> = {};
  const snapshots: Snapshot[] = [];
  for (const name of names) {
    const loaded = await loadRecipe(home, name);
    if (loaded.conflicts.length) return { recipes: {}, snapshots: [], conflicts: loaded.conflicts };
    // SAFETY: loadRecipe returns a recipe unless its conflicts are nonempty.
    recipes[name] = loaded.recipe!;
    snapshots.push(...loaded.snapshots);
  }
  return { recipes, snapshots, conflicts: [] };
}

// Detect the recipe-local behavior module without importing it: import
// stays demand-first inside Core planning. The fixed filename keeps stored
// data out of module resolution; symlinks are rejected so the import can
// never escape the recipe directory through a link trick.
async function readBehaviorFile(
  home: string,
  name: string,
): Promise<{ path?: string; snapshot?: Snapshot }> {
  const candidate = behaviorPath(home, name);
  const status = await lstat(candidate).catch(() => null);
  if (!status) return {};
  if (status.isSymbolicLink())
    throw new Error(`Recipe behavior must not be a symlink: ${candidate}`);
  if (!status.isFile()) throw new Error(`Recipe behavior must be a regular file: ${candidate}`);
  const contents = await read(candidate);
  if (contents === null) throw new Error(`Recipe behavior disappeared: ${candidate}`);
  return { path: candidate, snapshot: { path: candidate, hash: fingerprint(contents) } };
}

export async function loadRecipe(home: string, name: string): Promise<LoadedRecipe> {
  const directory = recipeDir(home, name);
  if ((await entryType(directory)) !== "directory") {
    const available = ((await listDirectory(join(home, "recipes"))) ?? []).sort();
    return {
      snapshots: [],
      conflicts: [
        `Unknown recipe: ${name}.${available.length ? ` Available: ${available.join(", ")}` : " No recipes are saved yet."}`,
      ],
    };
  }
  try {
    const document = await readRecipeDocument(home, name);
    const stored = await readRecipeArtifacts(home, name);
    const behavior = await readBehaviorFile(home, name);
    const text = document.text;
    return {
      recipe: {
        name,
        artifacts: stored.artifacts,
        includes: document.includes.length ? document.includes : undefined,
        customizations: document.customizations.length ? document.customizations : undefined,
        ...(behavior.path ? { behaviorFile: behavior.path } : {}),
      },
      snapshots: [
        { path: recipeJsonPath(home, name), hash: fingerprint(text) },
        ...stored.snapshots,
        ...(behavior.snapshot ? [behavior.snapshot] : []),
      ],
      conflicts: [],
    };
  } catch (error) {
    return {
      snapshots: [],
      conflicts: [error instanceof Error ? error.message : String(error)],
    };
  }
}
