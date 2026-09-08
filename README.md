# Tamo

Tamo lets coding agents and developers learn, remember, reuse, and evolve how a developer likes projects to be set up, while leaving the resulting projects completely ordinary and developer-owned. It works directly as a CLI and as a deterministic tool for coding agents; an agent makes it smarter but is never required.

Implemented so far:

- `tamo inspect` — factual report of a Node/pnpm project's setup (package manager, dependencies, recognized config files, limitations).
- `tamo pack <name>` — capture the reusable parts of the current project as a reviewed recipe under the Tamo home. The source project is never modified.
- `tamo create <dir> --recipe <name>` — replay a saved recipe into a new, ordinary project: native artifacts at their original paths (the package name follows the new target) and a planned `pnpm install`.
- `tamo add effect-oxlint` — add the preferred Effect lint setup to an existing pnpm project while preserving its Oxlint configuration.

`tamo --help` prints the command overview; `tamo <command> --help` prints that command's usage and supported flags.

## Agent skill

The canonical coding-agent skill lives at `skills/tamo/SKILL.md`. It teaches compatible coding agents how to operate the globally installed `tamo` CLI. The skill is instructions only — installing it does not install the Tamo executable itself.

Install it with the [`skills`](https://skills.sh/) CLI (flag syntax verified with `skills@1.5.24`; substitute this repository's actual GitHub path — it has no public remote yet):

```sh
npx skills add <owner>/<repo> --skill tamo      # project-level
npx skills add <owner>/<repo> --skill tamo -g   # global
```

## Tamo home

All developer-owned state lives under the Tamo home (default `~/.tamo`, relocated by `TAMO_HOME`):

```text
~/.tamo/
└── recipes/     one directory per recipe (recipe.json plus artifacts/,
                optionally behavior.mjs — trusted local executable code)
```

A recipe's `behavior.mjs`, when present, is imported and executed during
planning — before any operation is confirmed or applied. Only the fixed
`behavior.mjs` filename inside the resolved local recipe directory is ever
loaded; nothing is fetched from the network and no sandboxing is applied.
Do not store recipes from untrusted sources without reviewing that file.

Projects never carry Tamo metadata; the resulting projects stay ordinary even if Tamo is deleted. Tests isolate global state by setting `TAMO_HOME`.

## Run locally

Requires Node.js 24.15+ and pnpm. Tamo is one TypeScript package; no build step is required.

```sh
pnpm install
pnpm --silent tamo inspect --cwd /path/to/project --json
pnpm tamo pack web --cwd /path/to/project --include tsconfig.json --yes
pnpm --silent tamo create my-app --recipe web --json --yes
pnpm tamo add effect-oxlint --cwd /path/to/project --dry-run
```

Installed globally, `tamo` runs its planned pnpm operations itself on Windows; launching through `pnpm tamo` is not required.

### Pack

`pack` inspects the target and builds a recipe: the manifest is captured as a native artifact (minus the source project's `name` and `version`, which are project identity rather than reusable setup), dependencies can be trimmed with `--exclude`, and other files are captured only when explicitly included (`--include`; a path may be a file or a directory, which expands into its contained files). Stored content is native file bytes under `~/.tamo/recipes/<name>/` (`recipe.json` plus `artifacts/` mirroring project paths), so replay never depends on the source project and never re-encodes native configuration. Secrets, private keys, generated output, dependency directories, caches, VCS state, and lockfiles are never captured, and including them is rejected; `.env.example` is deliberately allowed as reusable seed content.

Noninteractive/JSON contract (first-class for agents): `--json --dry-run` prints the recipe with status `dry-run`; without `--yes`, status `confirmation-required` and exit 2; `--yes` saves with status `saved`; conflicts exit 1 with status `blocked`. Repacking over an existing recipe requires `--force` and rebuilds from the current project rather than merging the old recipe.

### Create

```sh
pnpm tamo create <dir> --recipe <name>
```

Replays a recipe into a new ordinary project through the same Core planning path as `add`: native artifacts materialize at their original relative paths (the package name follows the new target directory; nothing else is invented), then a planned, visible `pnpm install`. When a recipe's behavior must generate the target first (an upstream initializer), `create` reviews and applies that preparation plan on its own, then replans from fresh state — one checkpoint at most — and the created package name still follows the target while generated state is preserved. Pre-existing non-empty targets are blocked, never overwritten, and the result carries no Tamo metadata. The same `--dry-run`/`--json`/`--yes` contract applies: planning never mutates, noninteractive runs need `--yes`, and execution reports completed and remaining operations on failure. Not supported yet: `--with`/`--without` overrides.

### Add

`tamo add <recipe>` applies reusable setup to an existing project through recipes, artifact handlers, and Core planning. Every recipe — including `effect-oxlint` — is an ordinary durable recipe under `~/.tamo/recipes`: compatibility checks, additive config contribution that preserves unrelated settings, the install/patch command orchestration, and the custom plugin run through recipe-local `behavior.mjs`. Saved recipes resolve by name and may include other recipes with persistent omit customizations. When a recipe needs an upstream command to run before handlers can plan against its output, `add` reviews and applies that preparation plan first, then replans from fresh state; plans carry `requiresReplan: true` until the final stage. Projects are never configured to load Tamo code.

For machine-readable output, suppress pnpm's script banner:

```sh
pnpm --silent tamo add effect-oxlint --cwd /path/to/project --dry-run --json
```

Without `--yes`, interactive mode asks for confirmation. JSON mode and noninteractive mode return the plan with `confirmation-required` and exit 2. Dry-run never installs, patches, writes files, or runs validation probes. Conflicts and execution failures exit 1.

## Supported scope

- **inspect / pack / create**: one ordinary Node/pnpm project with a local `package.json`; a declared `packageManager` is reported. Workspaces, Rust/Cargo, and other ecosystems are future scope (a workspace or Cargo manifest produces an explicit note).
- **add with an effect-oxlint recipe**: one local pnpm project with `packageManager` declared in `package.json`; Effect `4.0.0-rc.112` and Oxlint `1.80.0` already declared and installed; exactly one `.oxlintrc.json` or `.oxlintrc.jsonc`; relative JSON/JSONC inherited configs without inherited plugin lists, options, or overrides. Existing unrelated rules and overrides are preserved; differing required values block application. The integration installs missing integration dependencies at supported versions, patches installed tooling through a reviewed command, and adds `.config/oxlint/tamo-effect.ts` — a local plugin with no dependency on Tamo. Validation runs isolated lint probes and cleans them up.

Inputs are fingerprinted before review and rechecked before execution. Execution is sequential. A failure reports completed and remaining operations; external commands may have partially changed files, and automatic rollback is not provided. Replan before retrying.

Native integration has been exercised on Windows x64. Other platforms have not been verified.

## Development

```sh
pnpm check
pnpm format
pnpm test:integration
```

`check` runs TypeScript, Tamo's own Effect/Oxlint configuration, oxfmt's format check, and focused tests. Tamo's own lint setup also includes the curated general rules (vendored [anti-slop](https://github.com/dmmulroy/anti-slop) subset and `oxlint-plugin-complexity`); `pnpm format` formats the TypeScript sources with [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html). The canonical effect-oxlint recipe lives at `test/fixtures/effect-oxlint` (`recipe.json` plus self-contained `behavior.mjs` plus `artifacts/`, including the custom plugin); its plugin bytes are asserted byte-for-byte against what Core plans, so the fixture is never reformatted. The integration test creates a temporary project from `test/fixtures/project`, installs real dependencies, exercises the CLI, and cleans it up. It may require registry access.

`src/plan.ts` contains the shared plan/operation types. `src/runtime.ts` executes reviewed plans through Effect. `src/compose.ts` owns recipe resolution, planning, and verification; `src/handler.ts` and `src/handlers/` carry artifact semantics; the canonical effect-oxlint recipe (`test/fixtures/effect-oxlint`: `recipe.json`, self-contained `behavior.mjs`, `artifacts/`) carries the Effect procedural behavior as durable recipe data. `src/inspect.ts` is the factual inspection, `src/recipes.ts` the recipe storage under the Tamo home, `src/pack.ts` the capture policy and recipe emit, and `src/create.ts` the replay planner.

See [SPEC.md](SPEC.md) for the contract and [PARKING_LOT.md](PARKING_LOT.md) for deferred work.
