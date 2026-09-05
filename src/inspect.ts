import { join } from "node:path";
import { read } from "./runtime.ts";

// Inspection is factual: it answers "what is actually here?" with evidence in
// the form of manifest values and present files. It deliberately holds no
// opinion about what should be reusable; that judgment belongs to pack review
// or the calling agent.
export type Inspection = {
  cwd: string;
  kind: "node" | "unknown";
  packageManager: string | null;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  configFiles: string[];
  notes: string[];
};

// Bounded set of confidently recognized plain config files. Executable configs
// (vite.config.ts and friends) are code, not facts, and stay out.
const configCandidates = [
  ".editorconfig",
  ".gitignore",
  ".npmrc",
  ".oxfmtrc.json",
  ".oxlintrc.json",
  ".oxlintrc.jsonc",
  "tsconfig.json",
];

// Bounded set of manifests from other ecosystems; their presence is reported
// as a fact so callers can see they were recognized, not overlooked.
const unsupportedManifests = ["Cargo.toml", "go.mod", "pyproject.toml"];

function dependencySection(
  manifest: Record<string, unknown>,
  section: string,
  notes: string[],
): Record<string, string> {
  const value = manifest[section];
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    notes.push(`package.json ${section} is not an object; ignoring it.`);
    return {};
  }
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") {
      notes.push(`package.json ${section}.${name} is not a version string; ignoring it.`);
      continue;
    }
    dependencies[name] = version;
  }
  return dependencies;
}

export async function inspectProject(cwd: string): Promise<Inspection> {
  const notes: string[] = [];
  const inspection: Inspection = {
    cwd,
    kind: "unknown",
    packageManager: null,
    dependencies: {},
    devDependencies: {},
    configFiles: [],
    notes,
  };

  if ((await read(join(cwd, "pnpm-workspace.yaml"))) !== null)
    notes.push("pnpm-workspace.yaml present; workspace operations are not supported yet.");

  for (const name of unsupportedManifests)
    if ((await read(join(cwd, name))) !== null)
      notes.push(`${name} present; only Node projects are supported so far.`);

  const manifestText = await read(join(cwd, "package.json"));
  if (manifestText === null) {
    notes.push("No package.json; only Node projects are understood so far.");
    return inspection;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    notes.push("package.json is not valid JSON.");
    return inspection;
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    notes.push("package.json is not a JSON object.");
    return inspection;
  }
  // SAFETY: the guard above narrowed manifest to a non-array object.
  const record = manifest as Record<string, unknown>;

  inspection.kind = "node";
  const packageManager = record.packageManager;
  if (typeof packageManager === "string") inspection.packageManager = packageManager;
  else notes.push("package.json declares no packageManager field.");
  inspection.dependencies = dependencySection(record, "dependencies", notes);
  inspection.devDependencies = dependencySection(record, "devDependencies", notes);

  for (const name of configCandidates)
    if ((await read(join(cwd, name))) !== null) inspection.configFiles.push(name);

  return inspection;
}
