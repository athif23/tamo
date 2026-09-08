import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { layer as nodeServices, type NodeServices } from "@effect/platform-node/NodeServices";
import type { PlatformError } from "effect/PlatformError";
import type { Operation, Plan } from "./plan.ts";
import { fingerprint } from "./plan.ts";

// All platform work runs on Effect's FileSystem, Path, and ChildProcessSpawner
// services, supplied by NodeServices.layer at this single boundary. The plain
// promise exports are the only surface the feature contract and CLI consume.
const run = <A, E>(effect: Effect.Effect<A, E, NodeServices>): Promise<A> =>
  // Entry point: every plain helper call is its own root fiber with the Node services provided once.
  // oxlint-disable-next-line effecttsgo/strict-effect-provide
  Effect.runPromise(Effect.provide(effect, nodeServices));

function isNotFound(error: PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

export function read(path: string): Promise<string | null> {
  return run(readFileOrNull(path));
}

// Binary-safe read for seed-content capture; text goes through read().
export function readBytes(path: string): Promise<Uint8Array | null> {
  return run(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readFile(path).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null))),
    ),
  );
}

const readFileOrNull = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(path).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null))),
  );

// Raw-byte read for reviewed-input rechecking: snapshots hash raw bytes
// (see fingerprint), so the recheck must compare raw bytes too — text
// decoding would alias distinct binaries and break the comparison.
const readFileBytesOrNull = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFile(path).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null))),
  );

// Windows pnpm resolution for a globally invoked `tamo`: the process runner
// avoids a shell by executing pnpm's JavaScript entry through the current
// Node. The entry is located in the smallest robust way — first the
// pnpm-managed entry when Tamo itself runs under pnpm, otherwise a PATH
// scan for a pnpm shim with its sibling JS entry or a standalone pnpm.exe.
// No absolute install path is hardcoded and no shell is introduced.
function isPnpmEntry(entry: string): boolean {
  return /pnpm\.(?:c?js|mjs)$/i.test(entry);
}

export type WindowsPnpmLookup = {
  npmExecpath?: string;
  pathEnv?: string;
  nodeExecutable?: string;
  fileExists?: (path: string) => boolean;
};

function stripQuotes(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"'))
    return trimmed.slice(1, -1);
  return trimmed;
}

const pnpmJsCandidates = ["pnpm.mjs", "pnpm.cjs", "pnpm.js"];

// Probe one PATH directory for a runnable pnpm without a shell: a
// standalone pnpm.exe wins, otherwise a pnpm.cmd shim's sibling JS entry
// runs through Node. Returns null when this directory yields nothing.
function probeWindowsPnpmDir(
  dir: string,
  nodeExecutable: string,
  args: string[],
  fileExists: (path: string) => boolean,
): { executable: string; args: string[] } | null {
  const exe = join(dir, "pnpm.exe");
  if (fileExists(exe)) return { executable: exe, args };

  const shim = join(dir, "pnpm.cmd");
  if (!fileExists(shim)) return null;
  const layouts = [
    join(dirname(shim), "..", "node_modules", "pnpm", "bin"),
    join(dirname(shim), "node_modules", "pnpm", "bin"),
  ];
  for (const layout of layouts)
    for (const file of pnpmJsCandidates) {
      const entry = join(layout, file);
      if (fileExists(entry)) return { executable: nodeExecutable, args: [entry, ...args] };
    }
  return null;
}

// The pnpm-managed entry wins when Tamo itself runs under pnpm; a missing
// or foreign entry falls through to the PATH scan.
function pnpmEntryViaNpmExecpath(
  npmExecpath: string | undefined,
  nodeExecutable: string,
  args: string[],
  fileExists: (path: string) => boolean,
): { executable: string; args: string[] } | null {
  if (!npmExecpath || !isPnpmEntry(npmExecpath)) return null;
  try {
    return fileExists(npmExecpath)
      ? { executable: nodeExecutable, args: [npmExecpath, ...args] }
      : null;
  } catch {
    return null;
  }
}

function probePathDir(
  raw: string,
  nodeExecutable: string,
  args: string[],
  fileExists: (path: string) => boolean,
): { executable: string; args: string[] } | null {
  const dir = stripQuotes(raw);
  if (!dir) return null;
  try {
    return probeWindowsPnpmDir(dir, nodeExecutable, args, fileExists);
  } catch {
    return null;
  }
}

// Pure, platform-independent core of the Windows lookup so tests can
// simulate Windows PATH layouts deterministically on any host.
export function resolveWindowsPnpm(
  args: string[],
  lookup: WindowsPnpmLookup = {},
): { executable: string; args: string[] } | null {
  const nodeExecutable = lookup.nodeExecutable ?? process.execPath;
  const fileExists = lookup.fileExists ?? existsSync;
  const viaManaged = pnpmEntryViaNpmExecpath(
    lookup.npmExecpath ?? process.env.npm_execpath,
    nodeExecutable,
    args,
    fileExists,
  );
  if (viaManaged) return viaManaged;
  // Windows PATH semantics explicitly: `;`-separated (drive letters contain
  // `:`), so tests can inject Windows-style layouts on any host.
  const pathEnv = lookup.pathEnv ?? process.env.PATH ?? "";
  for (const raw of pathEnv.split(";")) {
    const resolved = probePathDir(raw, nodeExecutable, args, fileExists);
    if (resolved) return resolved;
  }
  return null;
}

// Run pnpm's JS entry directly on Windows; never interpolate project input into a shell.
function prepare(executable: string, args: string[]): { executable: string; args: string[] } {
  if (executable === "pnpm" && process.platform === "win32") {
    const resolved = resolveWindowsPnpm(args);
    if (resolved) return resolved;
    throw new Error(
      "pnpm executable not found. Install pnpm and ensure it is on PATH, then retry.",
    );
  }
  return { executable, args };
}

const collectText = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  Stream.runFold(
    Stream.decodeText(stream),
    () => "",
    (acc, chunk) => acc + chunk,
  );

const runCommand = (executable: string, args: string[], cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const prepared = yield* Effect.try(() => prepare(executable, args));

      const handle = yield* spawner.spawn(
        ChildProcess.make(prepared.executable, prepared.args, {
          cwd,
          stdin: "ignore",
          windowsHide: true,
        }),
      );

      const out = yield* Effect.forkChild(collectText(handle.stdout));
      const err = yield* Effect.forkChild(collectText(handle.stderr));
      const code = yield* handle.exitCode;
      return { code: Number(code), stdout: yield* Fiber.join(out), stderr: yield* Fiber.join(err) };
    }),
  );

export function command(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(runCommand(executable, args, cwd));
}

export function write(path: string, contents: string): Promise<void> {
  return run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* fs.makeDirectory(pathService.dirname(path), { recursive: true });
      yield* fs.writeFileString(path, contents);
    }),
  );
}

// The directory is removed when the callback settles, fails, or the surrounding
// fiber is interrupted; validation probes never leave residue behind.
export function withTempDirectory<A>(
  prefix: string,
  directory: string,
  use: (path: string) => Promise<A>,
): Promise<A> {
  return run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* fs.makeTempDirectoryScoped({ directory, prefix });
        return yield* Effect.promise(() => use(path));
      }),
    ),
  );
}

export type ApplyResult = {
  status: "applied" | "failed" | "blocked";
  completed: Operation[];
  remaining: Operation[];
  errors: string[];
};

// Canonical execution: applies a reviewed Plan's operations sequentially with
// reviewed-input rechecking and partial-failure reporting. Takes a Plan only —
// validation/verification is owned by the caller (Core verification for
// recipes, created-project checks for create), never by the runtime.
export const executePlanEffect = (plan: Plan): Effect.Effect<ApplyResult, never, NodeServices> => {
  const completed: Operation[] = [];
  const work = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (plan.conflicts.length)
      return {
        status: "blocked",
        completed,
        remaining: plan.operations,
        errors: plan.conflicts,
      } satisfies ApplyResult;

    for (const input of plan.inputs) {
      const current = yield* readFileBytesOrNull(input.path);
      if (fingerprint(current) !== input.hash)
        return yield* Effect.fail(new Error(`Input changed; review a new plan: ${input.path}`));
    }

    for (const operation of plan.operations) {
      if (operation.kind === "write") {
        const current = yield* readFileOrNull(operation.path);
        if (current !== operation.before)
          return yield* Effect.fail(new Error(`File changed before write: ${operation.path}`));

        yield* fs.makeDirectory(path.dirname(operation.path), { recursive: true });
        yield* fs.writeFileString(operation.path, operation.after);
      } else {
        const result = yield* runCommand(operation.executable, operation.args, operation.cwd);
        if (result.code !== 0)
          return yield* Effect.fail(
            new Error(
              `${operation.purpose} failed (${result.code}). The command may have partially changed files.\n${result.stderr}\n${result.stdout}`,
            ),
          );
      }

      completed.push(operation);
    }

    return {
      status: "applied",
      completed,
      remaining: [],
      errors: [],
    } satisfies ApplyResult;
  });
  return Effect.matchCause(work, {
    onSuccess: (result): ApplyResult => result,
    onFailure: (cause): ApplyResult => ({
      status: "failed",
      completed,
      remaining: plan.operations.slice(completed.length),
      errors: [String(cause)],
    }),
  });
};

export function executePlan(plan: Plan): Promise<ApplyResult> {
  return run(executePlanEffect(plan));
}

export function entryType(path: string): Promise<"file" | "directory" | null> {
  return run(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.stat(path).pipe(
        Effect.map((info) =>
          info.type === "Directory" ? ("directory" as const) : ("file" as const),
        ),
        Effect.catchIf(isNotFound, () => Effect.succeed(null)),
      ),
    ),
  );
}

export function listDirectory(path: string): Promise<string[] | null> {
  return run(
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.readDirectory(path).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(null))),
    ),
  );
}
