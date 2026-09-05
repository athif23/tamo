import { basename, join, resolve } from "node:path";
import type { Extension, Plan } from "./plan.ts";
import { fingerprint } from "./plan.ts";
import { checkSeedContents } from "./pack.ts";
import { presetPath, validatePreset, type Preset } from "./preset.ts";
import { entryType, listDirectory, read } from "./runtime.ts";

// Create replays a preset into a new, ordinary project directory: the generated
// package.json plus seed content, then a planned, visible pnpm install. The
// result carries no Tamo metadata; the preset name or target directory name is
// used only where a normal package name is required.
export type CreatePreparation = {
  target: string;
  plan?: Plan;
  extension?: Extension;
  conflicts: string[];
};

async function loadPresetForCreate(
  home: string,
  presetName: string,
): Promise<{ preset?: Preset; path: string; text: string; conflicts: string[] }> {
  const path = presetPath(home, presetName);
  const text = await read(path);
  if (text === null) {
    const available = ((await listDirectory(join(home, "presets"))) ?? [])
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    return {
      path,
      text: "",
      conflicts: [
        `Unknown preset: ${presetName}.${available.length ? ` Available: ${available.join(", ")}` : " No presets are saved yet."}`,
      ],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { path, text, conflicts: [`Preset is not valid JSON: ${path}`] };
  }
  try {
    return { preset: validatePreset(value, path), path, text, conflicts: [] };
  } catch (error) {
    return { path, text, conflicts: [error instanceof Error ? error.message : String(error)] };
  }
}

async function targetConflicts(target: string): Promise<string[]> {
  const type = await entryType(target);
  if (type === "file") return [`Target exists and is not a directory: ${target}`];
  if (type === "directory") {
    const entries = await listDirectory(target);
    if (entries && entries.length)
      return [`Target directory is not empty: ${target}. Existing projects are never overwritten.`];
  }
  return [];
}

function generatedManifest(preset: Preset, target: string): Record<string, unknown> {
  const manifest: Record<string, unknown> = { name: basename(target) };
  if (preset.packageManager) manifest.packageManager = preset.packageManager;
  if (Object.keys(preset.dependencies).length) manifest.dependencies = preset.dependencies;
  if (Object.keys(preset.devDependencies).length) manifest.devDependencies = preset.devDependencies;
  return manifest;
}

// Post-execution validation: the manifest replays, seed content matches, and
// the planned install produced node_modules.
async function validateCreated(cwd: string, preset: Preset): Promise<string[]> {
  const errors: string[] = [];
  const manifestText = await read(join(cwd, "package.json"));
  if (manifestText === null) return [`Created manifest is missing: ${join(cwd, "package.json")}`];
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return ["Created package.json is not valid JSON."];
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    // SAFETY: the guards above narrowed manifest to a non-array object.
    (manifest as Record<string, unknown>).packageManager !== preset.packageManager
  )
    errors.push("Created package.json does not carry the preset's package manager.");

  for (const file of preset.files) {
    const contents = await read(join(cwd, file.path));
    if (contents !== file.contents)
      errors.push(`Seeded file does not match the preset: ${file.path}`);
  }
  if ((await entryType(join(cwd, "node_modules"))) !== "directory")
    errors.push("pnpm install did not produce node_modules.");
  return errors;
}

export async function planCreate(
  home: string,
  cwd: string,
  targetArgument: string,
  presetName: string,
): Promise<CreatePreparation> {
  const target = resolve(cwd, targetArgument);
  const { preset, path, text, conflicts } = await loadPresetForCreate(home, presetName);
  if (!preset) return { target, conflicts };

  const seedConflicts = [...(await targetConflicts(target)), ...checkSeedContents(preset.files)];
  if (seedConflicts.length) return { target, conflicts: seedConflicts };

  const operations = [
    {
      kind: "write" as const,
      path: join(target, "package.json"),
      before: null,
      after: `${JSON.stringify(generatedManifest(preset, target), null, 2)}\n`,
    },
    ...preset.files.map((file) => ({
      kind: "write" as const,
      path: join(target, file.path),
      before: null,
      after: file.contents,
    })),
    {
      kind: "command" as const,
      executable: "pnpm",
      args: ["install"],
      cwd: target,
      purpose:
        "Install the preset's dependencies and update the lockfile (lifecycle scripts enabled)",
    },
  ];

  const plan: Plan = {
    extension: "create",
    cwd: target,
    inputs: [{ path, hash: fingerprint(text) }],
    evidence: [
      `preset ${preset.name} (${preset.packageManager})`,
      `${Object.keys({ ...preset.dependencies, ...preset.devDependencies }).length} dependencies`,
      `${preset.files.length} seed files`,
    ],
    conflicts: [],
    operations,
    validation: [
      "Check generated manifest and seed content",
      "Check install produced node_modules",
    ],
  };

  const extension: Extension = {
    id: "create",
    description: `Create a project from preset ${preset.name}`,
    plan: async () => {
      throw new Error("create plans through planCreate, not the extension interface");
    },
    validate: (createdCwd) => validateCreated(createdCwd, preset),
  };
  return { target, plan, extension, conflicts: [] };
}
