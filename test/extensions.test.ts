import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensions, resolveExtension } from "../src/extensions.ts";
import { effectOxlint } from "../src/features/effect-oxlint.ts";
import type { Extension } from "../src/plan.ts";

const helloModule = `const extension = {
  id: "hello",
  description: "Test extension",
  plan: async () => ({ extension: "hello", cwd: "", inputs: [], evidence: [], conflicts: [], operations: [], validation: [] }),
  validate: async () => [],
};
export default extension;
`;

// Extensions load from the developer's Tamo home, so tests pass an isolated
// home directory instead of touching the real one.
async function withHome(
  run: (home: string) => Promise<void>,
  files: Record<string, string> = { "hello.ts": helloModule },
) {
  const home = await mkdtemp(join(tmpdir(), "tamo-extensions-"));
  try {
    await mkdir(join(home, "extensions"), { recursive: true });
    for (const [name, contents] of Object.entries(files))
      await writeFile(join(home, "extensions", name), contents);
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a home without an extensions directory contributes no extensions", async () => {
  const home = await mkdtemp(join(tmpdir(), "tamo-extensions-"));
  try {
    assert.deepEqual(await loadExtensions(home), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Tamo home extension modules load with relative-free discovery", async () => {
  await withHome(async (home) => {
    const extensions = await loadExtensions(home);
    assert.equal(extensions.length, 1);
    assert.equal(extensions[0]?.id, "hello");
    const resolved = resolveExtension("hello", [effectOxlint], extensions);
    assert.equal(resolved.id, "hello");
    assert.deepEqual(await resolved.plan({ cwd: home, read: async () => null }), {
      extension: "hello",
      cwd: "",
      inputs: [],
      evidence: [],
      conflicts: [],
      operations: [],
      validation: [],
    });
  });
});

test("multiple extension modules and multi-extension arrays load", async () => {
  const second = helloModule.replaceAll('"hello"', '"second"');
  await withHome(
    async (home) => {
      const extensions = await loadExtensions(home);
      assert.deepEqual(
        extensions.map((extension: Extension) => extension.id),
        ["hello", "second"],
      );
    },
    { "hello.ts": helloModule, "second.ts": second },
  );
});

test("malformed extension modules fail with actionable errors", async () => {
  await withHome(async (home) => {
    await writeFile(join(home, "extensions", "hello.ts"), "export default { nope: true };");
    await assert.rejects(loadExtensions(home), /must default-export an extension/);
  });
  await withHome(async (home) => {
    await writeFile(join(home, "extensions", "broken.ts"), "throw new Error('boom');");
    await assert.rejects(loadExtensions(home), /Failed to load extension module/);
  });
});

test("registry rejects duplicates and unknown ids with available options", async () => {
  await withHome(async (home) => {
    const extensions = await loadExtensions(home);
    assert.throws(
      () => resolveExtension("nope", [effectOxlint], extensions),
      /Unknown extension: nope\. Available: effect-oxlint, hello/,
    );
    assert.throws(
      () => resolveExtension("hello", [effectOxlint], [...extensions, ...extensions]),
      /Duplicate extension id: hello/,
    );
  });
});
