# Tamo

Tamo lets coding agents and developers learn, remember, reuse, and evolve how a developer likes projects to be set up, while leaving the resulting projects completely ordinary and developer-owned. It works directly as a CLI and as a deterministic tool for coding agents; an agent makes it smarter but is never required.

Implemented so far:

- `tamo inspect` — factual report of a Node/pnpm project's setup (package manager, dependencies, recognized config files, limitations).
- `tamo pack <name>` — capture the reusable parts of the current project as a reviewed preset under the Tamo home. The source project is never modified.
- `tamo create <dir> --preset <name>` — replay a saved preset into a new, ordinary project: generated `package.json`, seed files, and a planned `pnpm install`.
- `tamo add effect-oxlint` — add the preferred Effect lint setup to an existing pnpm project while preserving its Oxlint configuration.

## Tamo home

All developer-owned state lives under the Tamo home (default `~/.tamo`, relocated by `TAMO_HOME`):

```text
~/.tamo/
├── presets/     one plain JSON file per preset
└── extensions/  local extension modules (reusable custom behavior)
```

Projects never carry Tamo metadata; the resulting projects stay ordinary even if Tamo is deleted. Tests isolate global state by setting `TAMO_HOME`.

## Run locally

Requires Node.js 24.15+ and pnpm. Tamo is one TypeScript package; no build step is required.

```sh
pnpm install
pnpm --silent tamo inspect --cwd /path/to/project --json
pnpm tamo pack web --cwd /path/to/project --include tsconfig.json --yes
pnpm --silent tamo create my-app --preset web --json --yes
pnpm tamo add effect-oxlint --cwd /path/to/project --dry-run
```

### Pack

`pack` inspects the target and builds a preset candidate: manifest dependencies are suggested (`--exclude` drops some), and files are captured only when explicitly included (`--include`; a path may be a file or a directory, which expands into its contained files). Included content is stored inline in the preset, so replay never depends on the source project. Secrets, private keys, generated output, dependency directories, caches, VCS state, and lockfiles are never captured, and including them is rejected; `.env.example` is deliberately allowed as reusable seed content.

Noninteractive/JSON contract (first-class for agents): `--json --dry-run` prints the candidate with status `dry-run`; without `--yes`, status `confirmation-required` and exit 2; `--yes` saves with status `saved`; conflicts exit 1 with status `blocked`. An agent can edit the printed candidate and save it with `--from <file>`; edited candidates pass the same validation and policy. Repacking over an existing preset requires `--force` and rebuilds the candidate from the current project rather than merging the old preset.

The preset schema is deliberately minimal: `name`, `packageManager`, `dependencies`, `devDependencies`, `files` (`{ path, contents }` seed entries). Presets are plain files and may be hand-edited; seed paths are re-checked against the same safety rules at replay time.

### Create

```sh
pnpm tamo create <dir> --preset <name>
```

Replays a preset into a new ordinary project: a generated `package.json` (the target directory name becomes the package name; the preset's package manager and dependency sets are carried over; nothing else is invented), the seed files at their original relative paths, then a planned, visible `pnpm install`. Existing non-empty targets are blocked, never overwritten, and the result carries no Tamo metadata. The same `--dry-run`/`--json`/`--yes` contract applies: planning never mutates, noninteractive runs need `--yes`, and execution reports completed and remaining operations on failure. Not supported yet: `--with`/`--without` overrides, upstream CLI steps (e.g. `shadcn init`), and extension references — so framework-heavy presets replay as dependency-complete but unscaffolded projects.

### Extensions

Extensions provide reusable custom behavior when Tamo's generic primitives (dependencies, files, official CLIs) are insufficient — for example the built-in Effect Oxlint integration with its compatibility checks, additive JSONC mutation, patch command, and custom plugin. Each TypeScript module in `<Tamo home>/extensions` default-exports one extension or an array of extensions on the same plain-TypeScript interface as built-ins, and `tamo add <extension-id>` resolves them exactly like built-ins. Loading a module runs its code; only place extensions you trust there. Projects are never configured to load code.

```text
~/.tamo/extensions/my-setup.ts
```

For machine-readable output, suppress pnpm's script banner:

```sh
pnpm --silent tamo add effect-oxlint --cwd /path/to/project --dry-run --json
```

Without `--yes`, interactive mode asks for confirmation. JSON mode and noninteractive mode return the plan with `confirmation-required` and exit 2. Dry-run never installs, patches, writes files, or runs validation probes. Conflicts and execution failures exit 1.

On Windows, launch through `pnpm tamo`; the process runner uses pnpm's known JavaScript entry point rather than assembling a shell command.

## Supported scope

- **inspect / pack / create**: one ordinary Node/pnpm project with a local `package.json`; a declared `packageManager` is reported. Workspaces, Rust/Cargo, and other ecosystems are future scope (a workspace or Cargo manifest produces an explicit note).
- **add effect-oxlint**: one local pnpm project with `packageManager` declared in `package.json`; Effect `4.0.0-rc.112` and Oxlint `1.80.0` already declared and installed; exactly one `.oxlintrc.json` or `.oxlintrc.jsonc`; relative JSON/JSONC inherited configs without inherited plugin lists, options, or overrides. Existing unrelated rules and overrides are preserved; differing required values block application. The integration installs missing integration dependencies at supported versions, patches installed tooling through a reviewed command, and adds `.config/oxlint/tamo-effect.ts` — a local plugin with no dependency on Tamo. Validation runs isolated lint probes and cleans them up.

Inputs are fingerprinted before review and rechecked before execution. Execution is sequential. A failure reports completed and remaining operations; external commands may have partially changed files, and automatic rollback is not provided. Replan before retrying.

Native integration has been exercised on Windows x64. Other platforms have not been verified.

## Development

```sh
pnpm check
pnpm format
pnpm test:integration
```

`check` runs TypeScript, Tamo's own Effect/Oxlint configuration, oxfmt's format check, and focused tests. Tamo's own lint setup also includes the curated general rules (vendored [anti-slop](https://github.com/dmmulroy/anti-slop) subset and `oxlint-plugin-complexity`); `pnpm format` formats the TypeScript sources with [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html). The bundled `src/features/effect-oxlint/plugin.ts` is excluded from formatting because its contents are compared byte-for-byte against target projects. The integration test creates a temporary project from `test/fixtures/project`, installs real dependencies, exercises the CLI, and cleans it up. It may require registry access.

`src/plan.ts` contains the shared extension/plan types. `src/runtime.ts` executes plans through Effect. `src/inspect.ts` is the factual inspection, `src/preset.ts` the preset schema and Tamo-home storage, `src/pack.ts` the capture candidate and safety policy, and `src/create.ts` the replay planner; the built-in extension owns its inspection, additive config edits, and validation in `src/features/effect-oxlint.ts`. There is no extension-level apply hook.

See [SPEC.md](SPEC.md) for the contract and [PARKING_LOT.md](PARKING_LOT.md) for deferred work.
