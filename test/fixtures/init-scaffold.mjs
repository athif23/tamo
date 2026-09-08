#!/usr/bin/env node
// Deterministic upstream-CLI fixture for the preparation/replan experiment.
// Generates native project state that did not exist before preparation:
// a package.json, an Oxlint config, and one ordinary file. No network, no
// randomness, no side effects outside the given target directory.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [target, ...rest] = process.argv.slice(2);
if (!target) {
  console.error("expected a target directory");
  process.exit(2);
}
if (rest.includes("--fail")) {
  console.error("simulated initializer failure");
  process.exit(1);
}

mkdirSync(target, { recursive: true });
// --bare omits dependencies so create-stage `pnpm install` stays trivially
// offline-safe; the default output is unchanged for existing consumers.
const bare = rest.includes("--bare");
writeFileSync(
  join(target, "package.json"),
  `${JSON.stringify(
    {
      name: "scaffolded",
      ...(bare ? {} : { dependencies: { "generated-lib": "1.0.0" } }),
      scripts: { start: "node index.js" },
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(target, ".oxlintrc.jsonc"),
  `${JSON.stringify({ rules: { "generated-rule": "warn" } }, null, 2)}\n`,
);
writeFileSync(join(target, "index.js"), "console.log(\"scaffold\");\n");
