import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(".");

function help(...args: string[]) {
  const result = spawnSync(process.execPath, [join(root, "src/cli.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("top-level help stays an overview of all commands", () => {
  const output = help("--help");
  for (const command of ["inspect", "pack", "create", "add"]) assert.ok(output.includes(command));
  assert.ok(output.includes("tamo <command> --help"));
});

test("each command documents its own usage and flags", () => {
  const cases: [string[], string[]][] = [
    [
      ["inspect", "--help"],
      ["tamo inspect", "--cwd", "--json"],
    ],
    [
      ["pack", "--help"],
      [
        "tamo pack <recipe-name>",
        "--cwd",
        "--include",
        "--exclude",
        "--force",
        "--dry-run",
        "--json",
        "--yes",
      ],
    ],
    [
      ["create", "--help"],
      ["tamo create <dir>", "--recipe", "--cwd", "--dry-run", "--json", "--yes"],
    ],
    [
      ["add", "--help"],
      ["tamo add <recipe>", "--cwd", "--dry-run", "--json", "--yes"],
    ],
  ];
  const seen = new Set<string>();
  for (const [args, expected] of cases) {
    const output = help(...args);
    for (const text of expected) assert.ok(output.includes(text), `${args.join(" ")}: ${text}`);
    assert.ok(!seen.has(output), `${args.join(" ")} duplicates another command's help`);
    seen.add(output);
  }
  // Per-command help is specific: pack-only flags stay out of add's help.
  assert.ok(!help("add", "--help").includes("--include"));
  assert.ok(!help("inspect", "--help").includes("--recipe"));
});
