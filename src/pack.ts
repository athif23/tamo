import { join, relative, resolve } from "node:path";
import type { Artifact } from "./compose.ts";
import { packageManifestHandler } from "./handlers/package-manifest.ts";
import { inspectProject, type Inspection } from "./inspect.ts";
import { json, removeKey } from "./jsonc.ts";
import { entryType, listDirectory, readBytes } from "./runtime.ts";
import { lookupMap, mapField } from "./structure.ts";

// Pack turns a factual inspection into a reviewed recipe: the manifest
// captured as a native artifact plus explicitly included files. It never
// mutates the source project; its only output is a recipe directory under
// the Tamo home.
//
// Safety boundary: the manifest is always captured, but arbitrary
// application source is never captured automatically, and some state is
// never captured at all — secrets, generated output, dependency directories,
// caches, and lockfiles. .env.example is deliberately allowed: it is the
// conventional reusable environment template, not a secret.
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
// (re-checking recipe artifact paths without touching the filesystem).
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

// package.json is always captured as the recipe's manifest artifact, so it
// is not an include violation; create stamps the target name into it.
export function seedPathViolations(relativePath: string): string[] {
  return nameViolations(relativePath);
}

export type PackedRecipe = { name: string; artifacts: Artifact[] };

// Decoding must round-trip; a mismatch means the file is not UTF-8 text.
function utf8RoundTrips(contents: string, bytes: Uint8Array): boolean {
  const encoded = new TextEncoder().encode(contents);
  return encoded.length === bytes.length && encoded.every((byte, index) => byte === bytes[index]);
}

// UTF-8 with an optional BOM (EF BB BF) is valid text input: the BOM is a
// byte-order mark, not content — the default TextDecoder already strips it
// on decode, which is why a plain round-trip check misclassifies BOM files
// as binary. Pack normalizes the BOM away (the packed artifact decodes to
// the same text); the source file is never modified.
function withoutBom(bytes: Uint8Array): Uint8Array {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.slice(3)
    : bytes;
}

// Packability gate: only ordinary Node/pnpm projects can be packed so far.
function packableConflicts(inspection: Inspection): string[] {
  if (inspection.kind !== "node")
    return ["Only Node projects can be packed so far; no package.json was understood."];
  if (!inspection.packageManager?.startsWith("pnpm@"))
    return ["Only pnpm projects can be packed so far."];
  return [];
}

// Capture the manifest as a native artifact. Source-project identity (`name`
// and `version`) is not reusable, so both are stripped byte-surgically;
// everything else — private, type, scripts, engines, dependencies — is
// captured verbatim. A manually authored recipe may still contribute
// `version` explicitly; only pack's default capture drops it.
async function captureManifest(cwd: string): Promise<{ contents?: string; conflicts: string[] }> {
  const absolute = join(cwd, "package.json");
  const bytes = await readBytes(absolute);
  if (bytes === null) return { conflicts: [`Included path does not exist: package.json`] };
  const text = withoutBom(bytes);
  const contents = new TextDecoder().decode(text);
  if (!utf8RoundTrips(contents, text))
    return { conflicts: [`package.json is binary; artifacts support UTF-8 text only so far.`] };
  let stripped: string;
  try {
    const parsed = json(contents, "package.json");
    stripped = contents;
    if ("name" in parsed) stripped = removeKey(stripped, ["name"]);
    if ("version" in parsed) stripped = removeKey(stripped, ["version"]);
  } catch (error) {
    return { conflicts: [error instanceof Error ? error.message : String(error)] };
  }
  return {
    contents: stripped,
    conflicts: packageManifestHandler.validateAdjusted?.("package.json", stripped) ?? [],
  };
}

// Pack-time selection uses the shared structural machinery: each excluded
// package is omitted from the captured artifact through the manifest
// handler's own adjust, and only the final adjusted artifact is persisted —
// never an original plus a self-omit.
function applyExcludes(
  contents: string,
  excludes: string[],
): { contents: string; conflicts: string[] } {
  const conflicts: string[] = [];
  let adjusted = contents;
  for (const name of excludes) {
    let omitted = false;
    for (const selector of [mapField("dependencies"), mapField("devDependencies")]) {
      if (lookupMap(json(adjusted, "package.json"), selector).state !== "found") continue;
      const result = packageManifestHandler.adjust("package.json", adjusted, {
        op: "omit",
        selector: selector.name,
        entry: name,
      });
      if (result.conflicts.length) continue;
      adjusted = result.contents;
      omitted = true;
    }
    if (!omitted) conflicts.push(`Excluded package is not in the manifest: ${name}`);
  }
  return { contents: adjusted, conflicts };
}

// Pack a project into a leaf durable recipe: the captured manifest plus
// explicitly included files. Excludes select within the captured artifact;
// nothing is inferred about recipe ancestry (projects carry no provenance).
export async function packRecipe(
  cwd: string,
  name: string,
  includes: string[],
  excludes: string[],
): Promise<{ recipe?: PackedRecipe; conflicts: string[] }> {
  const gate = packableConflicts(await inspectProject(cwd));
  if (gate.length) return { conflicts: gate };
  const manifest = await captureManifest(cwd);
  if (manifest.contents === undefined) return { conflicts: manifest.conflicts };
  const selection = applyExcludes(manifest.contents, excludes);
  const included = await collectIncludedFiles(cwd, includes);
  const conflicts = [...manifest.conflicts, ...selection.conflicts, ...included.conflicts];
  if (included.files.some((file) => file.path === "package.json"))
    conflicts.push("package.json is always captured; do not pass it to --include.");
  if (conflicts.length) return { conflicts };
  return {
    recipe: {
      name,
      artifacts: [{ path: "package.json", contents: selection.contents }, ...included.files],
    },
    conflicts: [],
  };
}

// Included files are explicit choices, so they are checked against the
// denylist and the project boundary even though they never enter the recipe
// automatically. Included directories expand into their contained files, so a
// recipe is self-contained and can replay without the source project.
export async function collectIncludedFiles(
  cwd: string,
  includes: string[],
): Promise<{ files: Artifact[]; conflicts: string[] }> {
  const conflicts: string[] = [];
  const files: Artifact[] = [];
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
    const text = withoutBom(bytes);
    const contents = new TextDecoder().decode(text);
    if (!utf8RoundTrips(contents, text)) {
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

// Recipe artifact paths that arrive as data (a recipe being replayed) get
// the same policy without filesystem access.
export function checkSeedContents(files: Artifact[]): string[] {
  const conflicts: string[] = [];
  for (const file of files) conflicts.push(...seedPathViolations(file.path));
  return conflicts;
}
