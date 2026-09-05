import { join } from "node:path";
import { read, write } from "./runtime.ts";

// A preset is a developer-owned recipe for how a kind of project is normally
// set up: package manager, dependencies, and explicitly selected reusable seed
// content. It expresses replayable setup intent, not a snapshot of any
// project, and lives under the Tamo home — never inside projects. Seed files
// carry their contents inline so replay never depends on the source project;
// included directories expand into their contained files at pack time. The
// schema is deliberately minimal; more primitives (upstream CLI steps,
// extension references, options) are added only when real workflows need them.
export type PresetFile = { path: string; contents: string };

export type Preset = {
  name: string;
  packageManager: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  files: PresetFile[];
};

const allowedKeys = new Set(["name", "packageManager", "dependencies", "devDependencies", "files"]);
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function dependencyMap(value: unknown, key: string, source: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Preset ${key} must be an object: ${source}`);
  // SAFETY: the guard above narrowed value to a non-array object.
  const entries = Object.entries(value as Record<string, unknown>);
  const dependencies: Record<string, string> = {};
  for (const [name, version] of entries) {
    if (!name || typeof version !== "string" || !version)
      throw new Error(`Preset ${key} must map package names to version strings: ${source}`);
    dependencies[name] = version;
  }
  return dependencies;
}

function fileList(value: unknown, source: string): PresetFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`Preset files must be an array of { path, contents } entries: ${source}`);

  const files: PresetFile[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error(`Preset files entries must be { path, contents } objects: ${source}`);
    // SAFETY: the guard above narrowed entry to a non-array object.
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== 2 || !("path" in record) || !("contents" in record))
      throw new Error(`Preset files entries must have exactly path and contents keys: ${source}`);
    if (typeof record.contents !== "string")
      throw new Error(`Preset file contents must be strings: ${source}`);
    const path = normalizedSeedPath(record.path, source);
    if (!files.some((file) => file.path === path)) files.push({ path, contents: record.contents });
  }
  return files;
}

function normalizedSeedPath(path: unknown, source: string): string {
  if (typeof path !== "string" || !path)
    throw new Error(`Preset file paths must be non-empty strings: ${source}`);
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").includes("..")
  )
    throw new Error(`Preset file paths must stay inside the project: ${path}`);
  return normalized;
}

export function validatePreset(value: unknown, source: string): Preset {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Preset must be a JSON object: ${source}`);
  // SAFETY: the guard above narrowed value to a non-array object.
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!allowedKeys.has(key))
      throw new Error(
        `Unknown preset key "${key}" in ${source}. Supported keys: name, packageManager, dependencies, devDependencies, files.`,
      );

  const name = record.name;
  if (typeof name !== "string" || !namePattern.test(name))
    throw new Error(`Preset name must match ${namePattern.source}: ${source}`);
  const packageManager = record.packageManager;
  if (typeof packageManager !== "string" || !packageManager)
    throw new Error(`Preset packageManager must be a non-empty string: ${source}`);

  return {
    name,
    packageManager,
    dependencies: dependencyMap(record.dependencies, "dependencies", source),
    devDependencies: dependencyMap(record.devDependencies, "devDependencies", source),
    files: fileList(record.files, source),
  };
}

export function presetPath(home: string, name: string): string {
  return join(home, "presets", `${name}.json`);
}

export function serializePreset(preset: Preset): string {
  return `${JSON.stringify(preset, null, 2)}\n`;
}

export async function savePreset(home: string, preset: Preset): Promise<string> {
  const path = presetPath(home, preset.name);
  await write(path, serializePreset(preset));
  return path;
}

export async function loadPreset(home: string, name: string): Promise<Preset | null> {
  const path = presetPath(home, name);
  const text = await read(path);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Preset is not valid JSON: ${path}`);
  }
  return validatePreset(value, path);
}
