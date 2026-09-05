import { basename, relative, resolve } from "node:path";
import type { Inspection } from "./inspect.ts";
import { entryType, listDirectory, readBytes } from "./runtime.ts";
import type { Preset, PresetFile } from "./preset.ts";

// Pack turns a factual inspection into a reviewed preset candidate. It never
// mutates the source project; its only output is a preset under the Tamo home.
//
// Safety boundary: dependencies detected in the manifest may be suggested for
// inclusion, but arbitrary application source is never captured automatically,
// and some state is never captured at all — secrets, generated output,
// dependency directories, caches, and lockfiles. .env.example is deliberately
// allowed: it is the conventional reusable environment template, not a secret.
// This denylist is deliberately small and explicit rather than an attempt at
// universal secret detection.
const deniedDirectories = new Set([
  ".cache",
  ".git",
  ".next",
  ".output",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const deniedLockfiles = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function deniedFileName(name: string): boolean {
  if (/^\.env\.example$/.test(name)) return false;
  return (
    /^\.env($|\.)/.test(name) || deniedLockfiles.has(name) || /\.(log|p12|pem|pfx|key)$/.test(name)
  );
}

// Pure name-based policy, shared by pack (walking real files) and create
// (re-checking preset seed paths without touching the filesystem).
export function nameViolations(relativePath: string): string[] {
  const segments = relativePath.split("/");
  for (const segment of segments.slice(0, -1))
    if (deniedDirectories.has(segment))
      return [`${relativePath} is never captured (dependency, generated, or VCS state).`];
  const name = segments[segments.length - 1]!;
  if (deniedDirectories.has(name))
    return [`${relativePath} is never captured (dependency, generated, or VCS state).`];
  if (deniedFileName(name))
    return [`${relativePath} is never captured (secret or generated file).`];
  return [];
}

// Seed content must never carry the generated manifest; create owns it.
function manifestViolation(relativePath: string): string[] {
  return basename(relativePath).toLowerCase() === "package.json"
    ? [`${relativePath} would replace the generated package.json and cannot be seed content.`]
    : [];
}

export function seedPathViolations(relativePath: string): string[] {
  return [...manifestViolation(relativePath), ...nameViolations(relativePath)];
}

export type Candidate = { preset: Preset; conflicts: string[] };

// Decoding must round-trip; a mismatch means the file is not UTF-8 text.
function utf8RoundTrips(contents: string, bytes: Uint8Array): boolean {
  const encoded = new TextEncoder().encode(contents);
  return encoded.length === bytes.length && encoded.every((byte, index) => byte === bytes[index]);
}

// The candidate suggests every manifest dependency (the caller may exclude
// some) and captures no files; files are opt-in through explicit includes.
export function buildCandidate(inspection: Inspection, excludes: string[]): Candidate {
  const conflicts: string[] = [];
  if (inspection.kind !== "node")
    conflicts.push("Only Node projects can be packed so far; no package.json was understood.");
  else if (!inspection.packageManager?.startsWith("pnpm@"))
    conflicts.push("Only pnpm projects can be packed so far.");

  const exclude = new Set(excludes);
  const pick = (section: Record<string, string>) =>
    Object.fromEntries(Object.entries(section).filter(([name]) => !exclude.has(name)));
  for (const name of excludes)
    if (!(name in inspection.dependencies) && !(name in inspection.devDependencies))
      conflicts.push(`Excluded package is not in the manifest: ${name}`);

  const candidate: Preset = {
    name: "",
    packageManager: inspection.packageManager ?? "",
    dependencies: pick(inspection.dependencies),
    devDependencies: pick(inspection.devDependencies),
    files: [],
  };
  return { preset: candidate, conflicts };
}

// Included files are explicit choices, so they are checked against the
// denylist and the project boundary even though they never enter the candidate
// automatically. Included directories expand into their contained files, so a
// preset is self-contained and can replay without the source project.
export async function collectIncludedFiles(
  cwd: string,
  includes: string[],
): Promise<{ files: PresetFile[]; conflicts: string[] }> {
  const conflicts: string[] = [];
  const files: PresetFile[] = [];
  const collect = async (absolute: string, relativePath: string): Promise<void> => {
    const violations = seedPathViolations(relativePath);
    if (violations.length) {
      conflicts.push(...violations);
      return;
    }
    const type = await entryType(absolute);
    if (type === "directory") {
      for (const entry of (await listDirectory(absolute)) ?? [])
        await collect(`${absolute}/${entry}`, `${relativePath}/${entry}`);
      return;
    }
    if (type === null) {
      conflicts.push(`Included path does not exist: ${relativePath}`);
      return;
    }
    const bytes = await readBytes(absolute);
    if (bytes === null) {
      conflicts.push(`Included path does not exist: ${relativePath}`);
      return;
    }
    const contents = new TextDecoder().decode(bytes);
    if (!utf8RoundTrips(contents, bytes)) {
      conflicts.push(`${relativePath} is binary; seed content supports UTF-8 text only so far.`);
      return;
    }
    if (!files.some((file) => file.path === relativePath))
      files.push({ path: relativePath, contents });
  };
  for (const include of includes) {
    const absolute = resolve(cwd, include);
    const relativePath = relative(cwd, absolute).replaceAll("\\", "/");
    if (relativePath.startsWith("..") || absolute === cwd) {
      conflicts.push(`Included path must stay inside the project: ${include}`);
      continue;
    }
    await collect(absolute, relativePath);
  }
  return { files, conflicts };
}

// Preset seed paths that arrive as data (a --from candidate, or a preset being
// replayed) get the same policy without filesystem access.
export function checkSeedContents(files: PresetFile[]): string[] {
  const conflicts: string[] = [];
  for (const file of files) conflicts.push(...seedPathViolations(file.path));
  return conflicts;
}
