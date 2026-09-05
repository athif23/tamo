import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "./plan.ts";
import { listDirectory } from "./runtime.ts";

// Extensions are developer-level reusable behavior stored under the Tamo home
// (superseding the earlier project-level tamo.json mechanism, which made
// projects Tamo-aware). Each module in <home>/extensions default-exports one
// extension or an array of extensions. Directory scanning stays bounded to
// this one directory; package distribution, precedence rules, and a published
// SDK remain deferred.
async function importExtension(path: string): Promise<Extension[]> {
  let exported: unknown;
  try {
    exported = (await import(pathToFileURL(path).href)).default;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load extension module ${path}: ${message}`);
  }
  const list = Array.isArray(exported) ? exported : [exported];
  for (const entry of list)
    if (!isExtension(entry))
      throw new Error(
        `Extension module ${path} must default-export an extension or an array of extensions.`,
      );
  return list;
}

export function isExtension(value: unknown): value is Extension {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "plan" in value &&
    typeof value.plan === "function" &&
    "validate" in value &&
    typeof value.validate === "function"
  );
}

export async function loadExtensions(home: string): Promise<Extension[]> {
  const directory = join(home, "extensions");
  const entries = await listDirectory(directory);
  if (entries === null) return [];
  const extensions: Extension[] = [];
  for (const name of entries.filter((entry) => entry.endsWith(".ts")).sort())
    extensions.push(...(await importExtension(join(directory, name))));
  return extensions;
}

export function resolveExtension(
  id: string,
  builtins: Extension[],
  extensions: Extension[],
): Extension {
  const available = new Map<string, Extension>();
  for (const extension of [...builtins, ...extensions]) {
    if (available.has(extension.id))
      throw new Error(`Duplicate extension id: ${extension.id}. Extensions must use unique ids.`);
    available.set(extension.id, extension);
  }
  const extension = available.get(id);
  if (!extension)
    throw new Error(`Unknown extension: ${id}. Available: ${[...available.keys()].join(", ")}`);
  return extension;
}
