import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Artifact, RecipeBehavior } from "../src/compose.ts";

// Test helpers around the canonical durable Effect recipe at
// test/fixtures/effect-oxlint (recipe.json + behavior.mjs + artifacts/**).
// The recipe directory is the single implementation: tests and seeding copy
// it as a unit and never import Effect behavior from the Tamo checkout.

// Version pins mirrored from the canonical recipe's behavior.mjs and its
// package.json artifact for synchronous test setup (target manifests,
// installed markers). Drift is caught loudly: the artifact-opinion test
// asserts the canonical devDependencies equal these pins.
export const versions: Record<string, string> = {
  effect: "4.0.0-rc.112",
  oxlint: "1.80.0",
  "@effect/tsgo": "0.38.0",
  "oxlint-tsgolint": "7.0.2001",
  "@oxlint/plugins": "1.80.0",
};

function canonicalDir(): string {
  return fileURLToPath(new URL("./fixtures/effect-oxlint", import.meta.url));
}

export async function effectArtifacts(): Promise<Artifact[]> {
  const dir = join(canonicalDir(), "artifacts");
  const paths = ["package.json", ".oxlintrc.json", ".config/oxlint/tamo-effect.ts"];
  return Promise.all(
    paths.map(async (path) => ({ path, contents: await readFile(join(dir, path), "utf8") })),
  );
}

// In-memory recipe for fast unit tests. Test-owned fixture only — never
// injected by the CLI, which resolves durable home recipes exclusively. The
// behavior object is the canonical recipe's own default export.
export async function inMemoryEffectRecipe() {
  const behaviorUrl = pathToFileURL(join(canonicalDir(), "behavior.mjs")).href;
  // SAFETY: the canonical recipe's behavior.mjs default-exports the Effect
  // behavior object; Core revalidates the shape at the loading boundary.
  const mod = (await import(behaviorUrl)) as { default: RecipeBehavior };
  return {
    name: "effect-oxlint",
    behavior: mod.default,
    artifacts: await effectArtifacts(),
  };
}

// Probe expectations live with the canonical behavior; tests load the helper
// from the recipe rather than duplicating its positive-only derivation.
export async function loadProbeExpectations(): Promise<{
  (config: unknown): { ordinary: string[]; test: string[] };
}> {
  const behaviorUrl = pathToFileURL(join(canonicalDir(), "behavior.mjs")).href;
  // SAFETY: probeExpectations is a named export of the canonical recipe's
  // behavior.mjs alongside the default behavior object.
  const mod = (await import(behaviorUrl)) as {
    probeExpectations: (config: unknown) => { ordinary: string[]; test: string[] };
  };
  return mod.probeExpectations;
}

// Seed a durable recipe directory by copying the canonical recipe as a
// unit: no re-export stub, no checkout file URL, no per-file rebuilding.
export async function seedEffectRecipe(home: string, name = "effect-oxlint"): Promise<void> {
  await cp(canonicalDir(), join(home, "recipes", name), { recursive: true });
}
