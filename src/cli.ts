#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { relative, resolve } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Terminal from "effect/Terminal";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { layer as nodeServices } from "@effect/platform-node/NodeServices";
import { effectOxlint } from "./features/effect-oxlint.ts";
import { loadExtensions, resolveExtension } from "./extensions.ts";
import { tamoHome } from "./home.ts";
import { planCreate } from "./create.ts";
import { inspectProject, type Inspection } from "./inspect.ts";
import { buildCandidate, checkSeedContents, collectIncludedFiles } from "./pack.ts";
import { presetPath, savePreset, validatePreset, type Preset } from "./preset.ts";
import { executeEffect, read, type ApplyResult } from "./runtime.ts";
import type { Extension, Plan } from "./plan.ts";

function showPlan(plan: Plan) {
  console.log(`${plan.extension} in ${plan.cwd}`);

  for (const evidence of plan.evidence) console.log(`  ${evidence}`);
  for (const conflict of plan.conflicts) console.log(`BLOCKED: ${conflict}`);
  if (!plan.operations.length && !plan.conflicts.length) console.log("No changes needed.");

  for (const operation of plan.operations) {
    if (operation.kind === "command") {
      console.log(
        `\nRun: ${operation.executable} ${operation.args.map((arg) => JSON.stringify(arg)).join(" ")}\n  ${operation.purpose}`,
      );
    } else {
      console.log(
        `\n${operation.before === null ? "Create" : "Edit"}: ${relative(plan.cwd, operation.path)}`,
      );
      if (operation.before !== null)
        console.log(
          operation.before
            .split(/\r?\n/)
            .map((line) => `- ${line}`)
            .join("\n"),
        );
      console.log(
        operation.after
          .split(/\r?\n/)
          .map((line) => `+ ${line}`)
          .join("\n"),
      );
    }
  }
  console.log(`\nValidate: ${plan.validation.join("; ")}`);
}

function showInspection(inspection: Inspection) {
  const title =
    inspection.kind === "node"
      ? `Node project${inspection.packageManager ? ` (${inspection.packageManager})` : ""}`
      : "Unknown project kind";
  console.log(`${title} in ${inspection.cwd}`);
  const list = (section: Record<string, string>) =>
    Object.entries(section)
      .map(([name, version]) => `${name}@${version}`)
      .join(", ");
  for (const [label, section] of [
    ["dependencies", inspection.dependencies],
    ["devDependencies", inspection.devDependencies],
  ] as const) {
    const entries = list(section);
    if (entries) console.log(`${label}: ${entries}`);
  }
  if (inspection.configFiles.length)
    console.log(`Config files: ${inspection.configFiles.join(", ")}`);
  for (const note of inspection.notes) console.log(`Note: ${note}`);
}

function showPreset(preset: Preset, target: string) {
  console.log(`Preset: ${preset.name}`);
  console.log(`Package manager: ${preset.packageManager}`);
  const list = (section: Record<string, string>) =>
    Object.entries(section)
      .map(([name, version]) => `${name}@${version}`)
      .join(", ");
  const dependencies = list(preset.dependencies);
  const devDependencies = list(preset.devDependencies);
  if (dependencies) console.log(`Dependencies: ${dependencies}`);
  if (devDependencies) console.log(`Dev dependencies: ${devDependencies}`);
  console.log(
    `Reusable files: ${preset.files.length ? preset.files.map((file) => file.path).join(", ") : "(none)"}`,
  );
  console.log(`Save to: ${target}`);
}

// Noninteractive callers get a structured prompt instead of hanging on stdin.
function confirm(question: string, jsonOutput: boolean, payload?: Record<string, unknown>) {
  return Effect.gen(function* () {
    if (!process.stdin.isTTY || jsonOutput) {
      if (jsonOutput) console.log(JSON.stringify({ ...payload, status: "confirmation-required" }));
      else console.error(`Review the ${question}, then pass --yes to apply noninteractively.`);
      process.exitCode = 2;
      return false;
    }
    const terminal = yield* Terminal.Terminal;
    yield* terminal.display(`${question} [y/N] `);
    const answer = yield* terminal.readLine.pipe(
      Effect.catchTag("QuitError", () => Effect.succeed(null)),
    );
    return answer !== null && answer.trim().toLowerCase() === "y";
  });
}

function reportResult(values: { json?: boolean }, plan: Plan, result: ApplyResult): void {
  if (values.json) {
    console.log(JSON.stringify({ plan, result }));
    return;
  }
  console.log(`${result.status}: ${result.completed.length} operations completed.`);
  if (result.status === "applied") console.log(`Validated: ${plan.validation.join("; ")}`);
  for (const error of result.errors) console.error(error);
  if (result.remaining.length)
    console.error(
      `${result.remaining.length} operations remain. Review a fresh plan before retrying.`,
    );
}

// Registry lookup combines built-ins with the developer's Tamo home extensions.
async function selectExtension(
  positionals: string[],
  cwdFlag: string | undefined,
): Promise<{ cwd: string; extension: Extension }> {
  if (positionals.length !== 2 || positionals[0] !== "add")
    throw new Error("Expected: tamo add <extension>. Use --help for supported options.");
  const cwd = resolve(cwdFlag ?? ".");
  const extension = resolveExtension(
    positionals[1],
    [effectOxlint],
    await loadExtensions(tamoHome()),
  );
  return { cwd, extension };
}

async function candidateFromInspection(
  name: string,
  cwd: string,
  includes: string[],
  excludes: string[],
): Promise<{ preset?: Preset; conflicts: string[] }> {
  const inspection = await inspectProject(cwd);
  const candidate = buildCandidate(inspection, excludes);
  // Unsupported projects report their conflicts instead of failing candidate
  // validation against a half-built preset.
  if (candidate.conflicts.length) return { conflicts: candidate.conflicts };
  const included = await collectIncludedFiles(cwd, includes);
  const preset = validatePreset(
    { ...candidate.preset, name, files: included.files },
    `pack ${name}`,
  );
  return { preset, conflicts: included.conflicts };
}

async function candidateFromFile(
  name: string,
  cwd: string,
  from: string,
  includes: string[],
): Promise<{ preset: Preset; conflicts: string[] }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(from, "utf8"));
  } catch (error) {
    throw new Error(`Candidate file must contain JSON: ${from} (${String(error)})`);
  }
  const parsed = validatePreset(value, from);
  const seedConflicts = checkSeedContents(parsed.files);
  const included = await collectIncludedFiles(cwd, includes);
  return {
    preset: validatePreset(
      { ...parsed, name, files: [...parsed.files, ...included.files] },
      `pack ${name}`,
    ),
    conflicts: [
      ...(parsed.name === name
        ? []
        : [`Candidate name "${parsed.name}" does not match "${name}".`]),
      ...seedConflicts,
      ...included.conflicts,
    ],
  };
}

// Pack preparation is a plain promise; the confirmation and save happen inside
// main's Effect scope, so this only computes what would be saved.
async function preparePack(
  positionals: string[],
  values: {
    cwd?: string;
    force?: boolean;
    from?: string;
    include?: string[];
    exclude?: string[];
  },
): Promise<{ home: string; target: string; preset?: Preset; conflicts: string[] }> {
  if (positionals.length !== 2 || !positionals[1])
    throw new Error("Expected: tamo pack <preset-name>. Use --help for supported options.");
  const name = positionals[1];
  const cwd = resolve(values.cwd ?? ".");
  const home = tamoHome();
  const target = presetPath(home, name);

  const candidate = values.from
    ? await candidateFromFile(name, cwd, resolve(values.from), values.include ?? [])
    : await candidateFromInspection(name, cwd, values.include ?? [], values.exclude ?? []);

  if ((await read(target)) !== null && !values.force)
    candidate.conflicts.push(
      `Preset '${name}' already exists at ${target}; pass --force to replace it.`,
    );
  return { home, target, preset: candidate.preset, conflicts: candidate.conflicts };
}

const HELP = `tamo <command> [options]

Commands:
  inspect [--cwd path] [--json]
      Report the factual setup of the target project: package manager,
      dependencies, recognized config files, and limitations.
  pack <preset-name> [--cwd path] [--include path]... [--exclude package]...
        [--from candidate.json] [--force] [--dry-run] [--json] [--yes]
      Capture the reusable parts of the current project as a preset under the
      Tamo home. Dependencies from the manifest are suggested; files are only
      captured when explicitly included. Secrets, generated output, dependency
      directories, caches, and lockfiles are never captured. The source project
      is never modified. A reviewed agent can edit a --dry-run --json candidate
      and save it with --from.
  create <dir> --preset <name> [--cwd path] [--dry-run] [--json] [--yes]
      Create a new ordinary project from a saved preset: a generated
      package.json (package manager and dependency sets), the preset's seed
      files at their original relative paths, and a planned pnpm install.
      Existing non-empty targets are never overwritten; the result carries no
      Tamo metadata.
  add <extension> [--cwd path] [--dry-run] [--json] [--yes]
      Apply reusable custom behavior to an existing project. Built-in
      extension: effect-oxlint (requires an existing pnpm project with Effect
      4.0.0-rc.112 and Oxlint 1.80.0). Additional extensions load from
      <Tamo home>/extensions.

Developer state (presets, extensions) lives under the Tamo home directory
(default ~/.tamo); set TAMO_HOME to relocate it.
On Windows: pnpm tamo <command> ...`;

const main = Effect.gen(function* () {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      "dry-run": { type: "boolean" },
      from: { type: "string" },
      force: { type: "boolean" },
      include: { type: "string", multiple: true },
      exclude: { type: "string", multiple: true },
      json: { type: "boolean" },
      preset: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const [command] = positionals;
  if (command === "inspect") return yield* inspectCommand(values);
  if (command === "pack") return yield* packCommand(positionals, values);
  if (command === "create") return yield* createCommand(positionals, values);
  yield* addCommand(positionals, values);
});

function* inspectCommand(values: { cwd?: string; json?: boolean }) {
  const inspection = yield* Effect.promise(() => inspectProject(resolve(values.cwd ?? ".")));
  if (values.json) console.log(JSON.stringify({ inspection }));
  else showInspection(inspection);
}

function reportBlocked(conflicts: string[], json: boolean) {
  if (json) console.log(JSON.stringify({ status: "blocked", conflicts }));
  else for (const conflict of conflicts) console.error(`BLOCKED: ${conflict}`);
  process.exitCode = 1;
}

function* packCommand(
  positionals: string[],
  values: {
    cwd?: string;
    json?: boolean;
    "dry-run"?: boolean;
    yes?: boolean;
    force?: boolean;
    from?: string;
    include?: string[];
    exclude?: string[];
  },
) {
  const prepared = yield* Effect.promise(() => preparePack(positionals, values));
  if (prepared.conflicts.length) {
    reportBlocked(prepared.conflicts, values.json ?? false);
    return;
  }
  // SAFETY: preparePack returns a preset unless its conflicts are nonempty, which is handled above.
  const preset = prepared.preset!;
  if (!values.json) showPreset(preset, prepared.target);
  if (values["dry-run"]) {
    if (values.json) console.log(JSON.stringify({ preset, status: "dry-run" }));
    return;
  }
  if (
    !values.yes &&
    !(yield* confirm(`Save preset '${preset.name}'?`, values.json ?? false, {
      preset,
      target: prepared.target,
    }))
  )
    return;
  const path = yield* Effect.promise(() => savePreset(prepared.home, preset));
  if (values.json) console.log(JSON.stringify({ preset, status: "saved", path }));
  else console.log(`Saved preset '${preset.name}' to ${path}`);
}

function* createCommand(
  positionals: string[],
  values: { cwd?: string; json?: boolean; "dry-run"?: boolean; yes?: boolean; preset?: string },
) {
  const targetArgument = positionals[1];
  const presetName = values.preset;
  if (positionals.length !== 2 || !targetArgument || !presetName)
    throw new Error(
      "Expected: tamo create <dir> --preset <name>. Use --help for supported options.",
    );
  const prepared = yield* Effect.promise(() =>
    planCreate(tamoHome(), resolve(values.cwd ?? "."), targetArgument, presetName),
  );
  if (prepared.conflicts.length) {
    reportBlocked(prepared.conflicts, values.json ?? false);
    return;
  }
  // SAFETY: planCreate returns a plan unless its conflicts are nonempty, which is handled above.
  const plan = prepared.plan!;
  const extension = prepared.extension!;
  if (!values.json) showPlan(plan);
  if (values["dry-run"]) {
    if (values.json) console.log(JSON.stringify({ plan, status: "dry-run" }));
    return;
  }
  if (
    !values.yes &&
    !(yield* confirm(
      `Create '${targetArgument}' from preset '${presetName}'?`,
      values.json ?? false,
      {
        plan,
        target: prepared.target,
      },
    ))
  )
    return;
  const result = yield* executeEffect(plan, extension);
  reportResult(values, plan, result);
  if (result.status !== "applied") process.exitCode = 1;
}

function* addCommand(
  positionals: string[],
  values: { cwd?: string; json?: boolean; "dry-run"?: boolean; yes?: boolean },
) {
  const { cwd, extension } = yield* Effect.promise(() => selectExtension(positionals, values.cwd));
  const plan = yield* Effect.promise(() => extension.plan({ cwd, read }));

  if (!values.json) showPlan(plan);
  if (plan.conflicts.length || values["dry-run"]) {
    if (values.json) console.log(JSON.stringify({ plan }));
    if (plan.conflicts.length) process.exitCode = 1;
    return;
  }

  if (!values.yes) {
    if (!(yield* confirm("Apply this plan?", values.json ?? false, { plan }))) return;
  }

  const result = yield* executeEffect(plan, extension);

  reportResult(values, plan, result);
  if (result.status !== "applied") process.exitCode = 1;
}

// Interruption (Ctrl+C) unwinds the fiber so running installs are killed and
// temporary validation files are removed; it is not reported as a failure.
// Entry point: the CLI is the single place the Node services layer is provided.
// oxlint-disable-next-line effecttsgo/strict-effect-provide
const program = Effect.catchCause(Effect.provide(main, nodeServices), (cause) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.void
    : Effect.sync(() => {
        const error = Cause.squash(cause);
        const message = error instanceof Error ? error.message : String(error);
        if (process.argv.includes("--json"))
          console.log(JSON.stringify({ status: "failed", errors: [message] }));
        else console.error(message);
        process.exitCode = 1;
      }),
);

runMain({ disableErrorReporting: true })(program);
