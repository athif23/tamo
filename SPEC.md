# Tamo Specification

> Status: Draft  
> Scope: V1  
> Working name: Tamo

The immediate implementation milestone is Slice 1 in section 15. Later V1 capabilities remain product direction, not prerequisites for that milestone. Where broader examples imply more machinery, the Slice 1 scope takes precedence.

Slice 1 is implemented as one pnpm package. See `README.md` for supported configuration arrangements, CLI usage, and verification commands. Broader V1 sections remain a draft.

> **Model revision (2026-09-05).** A stress test of 25 real workflows revised the product model. Tamo is now defined as persistent, user-owned project setup memory and deterministic execution for developers and coding agents — not an extension-centric integration registry. Sections marked **Superseded** retain implemented history; the active model lives in sections 1–5 and the Pack Slice in section 15. Key settlements:
>
> - A preset is a reusable setup *recipe* (package manager, dependencies, explicitly selected reusable files; later: upstream CLI steps, extension references, options), **not** a list of extension IDs and **not** a project snapshot.
> - Ordinary dependencies and straightforward official CLI invocations need **no** extension. Extensions are the escape hatch for reusable custom behavior that generic primitives cannot express.
> - Projects carry **no** Tamo metadata. The project-level `tamo.json` extension mechanism is superseded; extensions load from the developer's Tamo home, like presets.
> - `inspect` is the factual foundation; `pack` turns an inspection into a reviewed preset. Global state lives under an isolatable `TAMO_HOME`.

## 1. Purpose

Tamo lets coding agents and developers learn, remember, reuse, and evolve how a developer likes projects to be set up, while leaving the resulting projects completely ordinary and developer-owned.

It works both directly as a CLI and as a deterministic tool used by coding agents. A coding agent makes Tamo smarter and easier to use, but Tamo never fundamentally requires an agent. An agent should be able to use Tamo as persistent setup memory instead of repeatedly asking the developer which libraries, tools, config, folders, and conventions they normally use.

Core workflows:

- **Build normally, then capture.** Create a project with ordinary ecosystem tools (directly or through an agent). When satisfied, capture the reusable parts: `tamo pack web`, or an agent-driven equivalent.
- **Replay.** Create the next project from the stored recipe: `tamo create hello --preset web`. The result is an ordinary project, not a "Tamo project".
- **Evolve explicitly.** Change a project and separately update the preset when asked. Existing projects never silently change because a preset changed.
- **Override temporarily.** Use a preset with per-project additions or exclusions without storing them (`--with` / `--without` semantics, deferred).

Examples of remembered preferences:

- A web project may default to TanStack Start + React + Tailwind CSS + shadcn + Oxlint + Vitest.
- A TypeScript package may default to Oxlint + Vitest.
- Adding Effect may also imply the developer's preferred Effect lint rules and TypeScript tooling.
- An existing project can receive a feature such as Effect Oxlint rules without replacing unrelated existing configuration.

Tamo should reduce repetitive setup work while preserving normal project ownership.

## 2. Product Principles

### 2.1 The project belongs to the developer

Tamo produces and modifies ordinary project files.

Files such as these remain authoritative:

- `package.json`
- `.oxlintrc.json` / `.oxlintrc.jsonc`
- `tsconfig.json`
- `vite.config.ts`
- `Cargo.toml`
- `wrangler.jsonc`
- other ecosystem-native config files

Tamo must not require developers to express the full configuration of those tools in a Tamo-specific format.

A project must remain understandable and usable if Tamo is removed.

### 2.2 Tamo applies intent, not ownership

Tamo should behave like an intelligent setup assistant.

It may:

- create projects
- install packages
- invoke official CLIs
- add or merge configuration
- detect existing capabilities
- compare a project against user defaults
- validate changes

It should not regenerate and overwrite a project from a canonical Tamo representation.

### 2.3 Small primitives over rigid project types

Tamo Core should not hardcode a large taxonomy such as `WebApp`, `DesktopApp`, `ApiService`, or `Library`.

Instead, the core exposes a small vocabulary composed by real workflows:

- **Project** — an ordinary directory of ecosystem-native files; Tamo keeps no per-project state.
- **Inspection** — the factual structured model of a target ("what is actually here").
- **Preset** — a developer-owned, named, reusable setup recipe stored in the Tamo home.
- **Pack** — deterministic capture: inspect a project, build a reviewed candidate, save a preset. Never mutates the source project.
- **Create** — produce a new ordinary project from a preset (deferred).
- **Add** — change an existing project by adding a reusable capability.
- **Extension** — reusable custom executable behavior (plan/validate) for what generic primitives cannot express; the same interface serves built-ins.
- **Plan** — a reviewed set of concrete operations before any project mutation.
- **Operation** — one write or command record executed by the runtime.

Detection and config editing are ordinary integration functions. Operations are operation records, not another extension lifecycle. Global developer state (presets, extensions) lives under the Tamo home directory, isolatable for tests through `TAMO_HOME`; a project never needs a Tamo manifest simply because Tamo touched it.

Higher-level concepts such as "web" or "Effect package" are presets, not core types.

### 2.4 Built-ins use the public extension interface

Built-in custom behavior (currently `effect-oxlint`) uses the same extension interface available to users. There should be no privileged internal integration API. This keeps the public extension system practical and continuously tested.

Most technologies need no integration at all: ordinary dependencies are generic preset primitives and framework scaffolding belongs to official CLIs. Begin with one shared extension interface; publishing a stable SDK is not required.

### 2.5 Prefer official tooling when it exists

If a framework or library already provides a reliable CLI, Tamo should prefer orchestrating it instead of duplicating its scaffolding logic.

Tamo owns orchestration and developer preferences. Upstream tools should own framework-specific setup whenever practical.

### 2.6 Safe augmentation over replacement

Adding a feature to an existing project should preserve unrelated configuration.

For example, adding Effect lint rules to an existing Oxlint configuration should append or merge the required plugin/rules instead of replacing the entire file.

### 2.7 Deterministic when possible, agent-assisted when necessary

Tamo should prefer:

1. official CLI operations
2. deterministic structural edits
3. agent-assisted edits
4. manual instructions as a final fallback

Tamo does not need to understand every config language or every arbitrary source file in V1.

Agent-assisted execution is deferred. Slice 1 reports unsupported cases before mutation; it does not implement an agent-edit protocol.

### 2.8 Generic primitives first, extensions for the remainder

V1 should support the technologies actually used by the project owner well — through generic primitives (dependencies, files, package-manager operations, official CLI invocations) rather than per-technology integrations. Only behavior that generic primitives cannot express cleanly becomes an extension. An unknown library must work in presets without changing Tamo Core.

## 3. Tamo Implementation Stack

Tamo itself should be implemented in TypeScript using Effect, with Oxlint as the primary linter.

Initial implementation choices:

- TypeScript
- Effect
- Oxlint

Effect should be used where it improves Tamo's core runtime, especially for:

- command orchestration
- dependency and service composition
- filesystem/process abstractions
- typed errors
- validation flows
- resource management
- sequential execution of planned operations

Oxlint should provide the main linting feedback loop for the Tamo codebase.

Tamo's internal use of Effect must not make Effect a requirement for extension authors. Extension functions accept ordinary TypeScript data and may return values or promises. Adapt these at the runtime entry to extensions; do not expose Effect types through the extension interface.

Avoid wrapping simple pure transformations in Effect when ordinary TypeScript is clearer.

Config transformations, comparisons, rule selection, plan records, and output formatting use ordinary TypeScript. Use existing filesystem/process abstractions and one application runtime entry point; do not introduce an Effect service for each domain concept. Expected conflicts are planning results; I/O and process failures are operational errors.

Start with one package containing CLI, execution, and feature code. Extract shared integration helpers when another feature needs them. Tamo itself should use the Effect lint defaults defined in Slice 1, and later exercise `tamo add effect-oxlint` against its own repository.

## 4. Core User Problem

Without Tamo, a developer repeatedly tells coding agents things such as:

- use pnpm
- use TanStack Start for web apps
- add Tailwind CSS
- initialize shadcn
- use Oxlint instead of ESLint
- enable preferred Oxlint plugins
- when Effect is used, add preferred Effect lint rules
- use Vitest
- use a particular Cloudflare setup
- create a GPUI project under a particular workspace path

Tamo stores those preferences once and exposes them to coding agents through a stable CLI and structured output.

## 5. Core Concepts

### 4.1 Project

A project is a detected or explicitly created unit inside a repository.

Examples:

- repository root
- `apps/web`
- `apps/desktop`
- `packages/core`

Projects are not required to fit a fixed Tamo-defined type.

For Slice 1, a Project is one target directory plus inspected facts. No workspace graph or project class hierarchy is needed. The discovery examples below describe later scope.

Initial manifest-driven project detection:

| File | Possible detection |
| --- | --- |
| `package.json` | Node / JavaScript / TypeScript project |
| `Cargo.toml` | Rust project |
| `go.mod` | Go project |
| `pyproject.toml` | Python project |
| `pnpm-workspace.yaml` | pnpm workspace / monorepo |

Framework and library detection happens after project discovery.

### 4.2 Extension

An extension provides reusable custom behavior when Tamo's generic primitives are insufficient. It inspects relevant state, plans changes, and validates the resulting capability. The runtime alone applies planned operations.

Extensions are appropriate for things like complex config transformations (the Effect Oxlint integration: compatibility checks, additive JSONC mutation, patch commands, custom plugin files, validation probes), organization lint policy, or custom project-generation logic. They are **not** appropriate for installing an npm dependency, installing a Cargo crate, invoking a straightforward official CLI, or capturing a reusable file — generic primitives cover those.

Conceptual API:

```ts
const effectOxlint = {
  id: "effect-oxlint",
  description: "Add the preferred Effect lint configuration to Oxlint",

  plan(ctx) {
    // Use read-only access to inspect prerequisites and configuration.
    // Return concrete operations, evidence, and any blocking conflicts.
  },

  validate(ctx) {
    // Inspect fresh state and check that the integration works.
  },
}
```

There is no extension-level `apply` hook. Detection is initially private extension code rather than a separate registered hook. Planning must not mutate files or run installation/patch commands.

Extensions may plan package installation, external commands, and file edits. For Slice 1, Effect and Oxlint are preconditions: missing prerequisites block the plan rather than automatically invoking other extensions. Extension composition and dependency resolution are deferred.

### 4.3 Preset

> The earlier framing — "a preset is a reusable composition of features" with a YAML list of extension IDs — is **superseded**. It implied a bespoke integration for every library and failed the unknown-technology stress case.

A preset is a reusable description/recipe for how the developer normally creates or configures a kind of project. It describes reproducible setup intent rather than cloning an original project:

```text
initialize TanStack Start using this normal choice
install these normal packages
initialize shadcn
include these utility files
apply this custom lint behavior (extension reference)
```

The implemented preset schema (see the Pack Slice, section 15) is deliberately minimal: `name`, `packageManager`, `dependencies`, `devDependencies`, and explicitly selected `files` — seed entries carrying their contents inline (`{ path, contents }`), so replay never depends on the source project; included directories expand into their contained files at pack time. Primitives such as upstream CLI steps, extension references, and options are added only when real workflows need them.

Presets may eventually compose or fork other presets; that machinery is deferred. Presets live as plain files under the Tamo home and are hand-editable.

### 4.4 Config

Tamo config stores developer-level defaults and preferences.

Global preference resolution is deferred until after Slice 1. Initial lint choices live in extension-owned resources.

Example:

```yaml
defaults:
  packageManager: pnpm
  webPreset: web
  packagePreset: package
```

Tamo config should not mirror every ecosystem-native config value.

For example, Oxlint rules should normally live in Oxlint config fragments or extension-owned resources, not be re-encoded into a universal Tamo schema.

### 4.5 Inspection

Inspection produces the factual structured model of a target: package manager, language, manifests, dependencies, confidently detectable tooling, relevant config files, workspace information where supported, and evidence. It answers only "what is actually here?" and holds no opinion about what should be reusable — that judgment belongs to pack review or the calling agent.

`inspect`, `pack`, later status/comparison, and the agent JSON interface all consume the same inspection. Detector code is ordinary integration code, not an independently registered primitive in Slice 1.

Conceptual result:

```ts
{
  kind: "node",
  packageManager: "pnpm@10.11.0",
  dependencies: { effect: "4.0.0-rc.112" },
  configFiles: [".oxlintrc.jsonc", "tsconfig.json"],
  notes: ["pnpm-workspace.yaml present; workspace operations are not supported yet."]
}
```

Unsupported or ambiguous state is reported explicitly as notes rather than guessed.

### 4.6 Tamo home

All developer-owned Tamo state lives under one home directory:

```text
~/.tamo/
├── presets/       one plain JSON file per preset
└── extensions/    local extension modules (reusable custom behavior)
```

`TAMO_HOME` relocates the home so tests never touch the real developer home. The home is the developer's data; projects never reference it implicitly.

### 4.7 Operation

An operation is a concrete record inside a Plan. The initial executor supports:

- File edit: target path, expected original contents (or expected absence), and proposed contents.
- Command: executable, argument list, working directory, and purpose.

Reads are planning inputs, not mutation actions. JSON/JSONC editing happens inside the integration to produce proposed file contents. The executor does not interpret Oxlint rules or expose a catalog of parser-specific actions.

Execute operations in order. Installation commands may change lockfiles and installed packages; the plan must disclose those effects even when their exact generated diff cannot be known beforehand.

### 4.8 Plan

Every mutating operation should be able to produce a plan before applying changes.

A plan describes:

- target project
- detected state
- requested state
- changes
- files affected
- commands to run
- unresolved requirements
- validation steps
- potential conflicts

`--dry-run` should produce the plan without modifying files.

Plans are structured, in-memory data independent of CLI rendering. The runtime renders the plan, obtains confirmation, executes its operations, invokes validation, and returns a structured result. It must not independently recalculate edits during application.

Blocking conflicts prevent all mutations. Recheck inspected inputs before execution; changed inputs require replanning and renewed review. Commands and file edits must have explicit ordering so that package-manager writes cannot be overwritten by an edit based on old contents.

On execution or validation failure, report completed operations and remaining work. Automatic rollback, persistent plans, and concurrent mutations are deferred.

## 6. CLI

The V1 CLI should remain small.

Implemented so far: `inspect`, `pack <name>`, and `add effect-oxlint`, each with the universal flags below and basic help. The other commands in this section describe later milestones. In particular, `create` awaits preset-application semantics (including temporary `--with`/`--without` overrides), and `status` comparison is deferred until those semantics exist.

### 5.1 Create

```bash
tamo create <dir> --preset <name>
```

Implemented for basic replay: load the preset, validate the target, plan, confirm, then generate the project — a `package.json` carrying the preset's package manager and dependency sets (the target directory name becomes the package name), the seed files at their original relative paths, and a planned, visible `pnpm install`. Existing non-empty targets are never overwritten. The result is an ordinary project with no Tamo metadata.

Not yet: temporary overrides (`--with`/`--without`), upstream CLI steps, extension references, workspace creation, and Rust/other-ecosystem presets.

### 5.2 Init

```bash
tamo init
```

Introduces Tamo to an existing repository.

V1 does not need perfect adoption.

`init` should:

1. discover workspace structure
2. detect known projects
3. detect known features
4. show the proposed understanding

It must not rewrite existing configs simply because the project was initialized. It must not create project-level Tamo metadata; projects carry no Tamo-owned state (see the superseded section 11).

### 5.3 Add

```bash
tamo add <thing>
```

Changes an existing project by adding a reusable capability. Currently the thing added is an extension id (`tamo add effect-oxlint`); later it may accept generic operations or presets once preset-application semantics exist.

Examples:

```bash
tamo add effect-oxlint
tamo add effect --to packages/core
```

Whether adding a new project to a workspace stays under `add` or receives a dedicated subcommand may be revisited after real usage.

### 5.4 Inspect

```bash
tamo inspect
```

Answers factually: **What is actually here?** Package manager, dependencies, confidently recognized config files, and explicit notes about unsupported or ambiguous state — with no judgment about what should be reusable.

Implemented for one Node/pnpm target directory; workspace discovery below remains deferred.

Machine-readable form:

```bash
tamo inspect --json
```

### 5.4b Pack

```bash
tamo pack <preset-name>
```

Turns the reusable parts of an existing project into a reviewed preset under the Tamo home. See the Pack Slice in section 15 for the settled semantics.

### 5.5 Status

```bash
tamo status
```

Answers: **How does the current project compare with the Tamo configuration, selected presets, or current defaults?**

It must distinguish actual project state from current user defaults.

Existing projects should not silently change because user defaults changed.

### 5.6 List

```bash
tamo list
```

Lists discoverable extensions and presets.

### 5.7 Show

```bash
tamo show <id>
```

Shows metadata for an extension or preset.

Example:

```bash
tamo show effect-oxlint
tamo show effect-oxlint --json
```

### 5.8 Preset

```bash
tamo preset list
tamo preset show <name>
tamo preset create <name>
tamo preset edit <name>
```

Preset management may begin as file-based configuration if interactive editing would slow V1.

### 5.9 Config

```bash
tamo config get
tamo config set <key> <value>
```

Config manages personal/global defaults such as package manager, default presets, and extension locations.

### 5.10 Doctor

```bash
tamo doctor
```

Checks Tamo runtime assumptions and relevant external tooling.

### 5.11 Universal Flags

```text
--dry-run
--json
--yes
--cwd <path>
```

`--json` is a first-class agent interface, not an afterthought.

## 7. Defaults

Tamo should remember common developer preferences.

Example:

```yaml
defaults:
  packageManager: pnpm

  presets:
    web: web
    package: package
```

A user should be able to change defaults without changing old projects.

Future projects use the new defaults. Existing projects remain unchanged unless explicitly migrated.

## 8. Existing Project Detection

Slice 1 inspects only its explicit target directory. Hierarchical discovery below is deferred until workspace operations are implemented.

Project discovery should be hierarchical:

```text
repository
  ↓
workspace detection
  ↓
project discovery
  ↓
feature detection per project
  ↓
resolved repository model
```

Example repository:

```text
.
├── pnpm-workspace.yaml
├── apps/
│   ├── web/
│   │   └── package.json
│   └── desktop/
│       └── Cargo.toml
└── packages/
    └── core/
        └── package.json
```

Possible detected model:

```text
workspace
  pnpm monorepo

apps/web
  node
  typescript
  tanstack-start
  react
  tailwind

apps/desktop
  rust
  gpui

packages/core
  node
  typescript
  effect
```

V1 should support obvious manifest-based cases first.

Unknown directories should remain unknown rather than being guessed aggressively.

## 9. Configuration Mutation

### 8.1 Native config remains the source of truth

Tamo must not duplicate complete ecosystem configuration into Tamo metadata.

Preferred:

```yaml
features:
  - oxlint
  - effect-oxlint
```

The actual Oxlint config remains in `.oxlintrc.json` or `.oxlintrc.jsonc`.

### 8.2 Additive modification

If the existing file is:

```json
{
  "plugins": ["react", "unicorn"],
  "rules": {
    "react/no-array-index-key": "warn",
    "unicorn/no-null": "off"
  }
}
```

adding `effect-oxlint` should preserve existing values and add only the required Effect configuration.

Tamo should not replace the entire file with its preferred default.

Mutation semantics:

| Existing state | Behavior |
| --- | --- |
| Required setting absent | Add it. |
| Equivalent setting present | Leave it unchanged. |
| Required setting explicitly differs | Preserve it and report a blocking conflict. |
| Config arrangement cannot be interpreted safely | Report it as unsupported before mutation. |

Preserve comments and unrelated formatting with targeted edits. Deduplicate equivalent plugin and preset entries. Preserve existing scripts; any script augmentation must appear in the plan. If it cannot be composed safely, block rather than replacing it.

Inherited settings and overrides affect the effective configuration. Merely inserting a rule is insufficient evidence that it is active. Support a bounded, tested configuration arrangement and report others as unsupported rather than guessing.

### 8.3 Initial config handlers

Slice 1 needs targeted JSON/JSONC edits to `package.json` and Oxlint configuration, plus creation of the feature's local lint plugin files. These are integration helpers, not a public config-handler registry.

Later candidates, only as another feature needs them:

- JSON
- JSONC
- `package.json`
- Oxlint config
- tsconfig
- pnpm workspace config
- Cargo TOML
- Wrangler JSONC

Other config types can be added incrementally.

### 8.4 Complex source config

Files such as arbitrary `vite.config.ts` may not be safely editable through a generic parser.

Slice 1 reports these cases as unsupported before mutation. A future agent-assisted operation could describe the file, semantic change, constraints, and validation command; that protocol remains in `PARKING_LOT.md`.

## 10. Extension Model

Tamo should be extensible without changes to Tamo Core, and without making projects Tamo-aware.

Extensions are developer-level reusable behavior, not project configuration: each TypeScript module under `<Tamo home>/extensions` default-exports one extension or an array of extensions on the shared extension interface (section 4.2). Tamo imports each module directly at invocation time; extension ids must not collide with built-ins. Loading runs module code as a trusted act by the developer who placed it there, and failures produce actionable errors. TypeScript modules load directly through the runtime's native type stripping.

> **Superseded:** an earlier slice loaded extensions from a project-level `tamo.json`. That made projects carry Tamo metadata and made extension availability per-project; it was removed after the 2026-09-05 model revision. Extension availability now follows the developer, like presets.

Still deferred: package distribution, precedence rules, a stable published SDK, remote extensions, and any scanning beyond the one extensions directory.

Generated lint plugins must run using ordinary project files and declared dependencies after Tamo is removed; they must not import the Tamo runtime.

## 11. Tamo Metadata

> **Superseded (2026-09-05).** Tamo no longer creates or reads a project-level `tamo.json`. A project must not require a Tamo-specific manifest simply because Tamo touched it; `pack`, presets, and extensions all operate without one. This section is retained so the implemented history stays understandable.

## 12. Agent Interface

Coding agents are first-class Tamo users.

The CLI should be:

- deterministic
- self-describing
- machine-readable
- safe to dry-run
- explicit about unresolved operations

Expected agent workflow:

The full workflow below is later V1 scope. Slice 1 exposes its plan and execution result through `add effect-oxlint --json`; `--dry-run` plans only, and `--yes` authorizes application. Noninteractive execution without `--yes` must not wait for a prompt or mutate files.

```bash
tamo inspect --json
tamo show effect-oxlint --json
tamo add effect-oxlint --dry-run --json
```

After user approval:

```bash
tamo add effect-oxlint --yes
```

An agent should not need a large prose skill to know the developer's normal project preferences.

## 13. Validation

Extensions should validate successful application.

Examples:

- dependency exists
- config contains expected integration
- official CLI completed
- `cargo check`
- `tsc --noEmit`
- `oxlint`
- relevant project-specific command

Validation should be scoped to the requested extension where practical.

Tamo should avoid turning every operation into a full CI run.

For Slice 1, check fresh configuration and package state, then verify actual lint integration through controlled input that demonstrates an enabled upstream Effect rule and the local Layer rule. Isolate and clean up any validation fixture.

Distinguish setup failure from project source code violating newly enabled rules. A nonzero full-project lint exit alone does not prove configuration failed. Report source diagnostics separately, and report any changes already applied when validation fails.

## 14. Initial Built-ins

V1 should prioritize the project owner's actual stack rather than broad ecosystem coverage. Most items below are covered by generic primitives (dependency installation) and official CLIs orchestrated at `create` time — they are **not** per-technology extensions. The initial built-in extension is the Effect Oxlint integration; more extensions appear only when generic primitives genuinely cannot express the behavior.

Relevant to the owner's stack:

- pnpm, TypeScript, Oxlint, Effect, Vitest, React — generic dependencies
- TanStack Start, Tailwind CSS, shadcn — official CLI invocations recorded as preset steps (primitive deferred)
- Effect Oxlint integration — the first built-in extension
- Cloudflare, Rust / Cargo, GPUI — future inspection/preset scope

Not every item must ship in the first implementation milestone.

## 15. First Vertical Slices

### Slice 1: Existing project + Effect Oxlint

Scenario:

- existing TypeScript project
- Oxlint already configured
- Effect already installed
- preferred Effect Oxlint rules missing

Support one explicitly targeted project with a local `package.json` and an unambiguous `.oxlintrc.json` or `.oxlintrc.jsonc`. JSONC parsing must preserve comments. Start with a bounded fixture covering existing unrelated rules, preset entries, and overrides; explicitly reject inheritance or targeting arrangements whose effective settings cannot be established. Arbitrary executable config and workspace discovery are outside this slice.

#### Default Effect lint content

The defaults below define Tamo's preferred Effect lint setup. `effect-oxlint` is Tamo's feature ID, not the npm package named `effect-oxlint`.

Use `@effect/tsgo`'s Oxlint integration:

- Extend `./node_modules/@effect/tsgo/oxlint-presets/correctness.json`.
- Ensure type-aware mode and the `effecttsgo` plugin are effective, as required by that preset.
- Set these explicit rules to `error`:
  - `effecttsgo/strict-effect-provide`
  - `effecttsgo/run-effect-inside-effect`
  - `effecttsgo/try-catch-in-effect-gen`
  - `effecttsgo/multiple-effect-provide`
  - `effecttsgo/scope-in-layer-effect`
  - `effecttsgo/layer-merge-all-with-dependencies`
  - `effecttsgo/leaking-requirements`
- Set `effecttsgo/strict-effect-provide` to `off` for `**/test/**` and `scripts/**`, preserving unrelated overrides.
- Include the custom `no-layer-in-service-class` rule at `error`: `Context.Service` classes define identity and contract; Layers are separate top-level exports. Distribute the rule as ordinary local plugin files, register it through `jsPlugins`, and declare its required dependencies. Use the reusable `tamo-effect` namespace.

These are personal Effect architecture defaults. Do not include project-specific source paths, React rules, general TypeScript rules, lint-debt snapshots, or unrelated scripts.

#### Installation and compatibility

The supported baseline versions are Effect `4.0.0-rc.112`, `@effect/tsgo` `0.38.0`, Oxlint `1.80.0`, `oxlint-tsgolint` `7.0.2001`, and `@oxlint/plugins` `1.80.0`. Use this combination as the initial fixture baseline, not a claim of compatibility with arbitrary versions.

Effect and Oxlint must already be installed. Plan installation of missing integration dependencies at supported versions. Do not silently upgrade existing incompatible dependencies; report them before mutation. Tamo and Slice 1 target projects use pnpm; other package managers are outside this slice.

Plan and execute `effect-tsgo patch --no-typescript --oxlint`. Add equivalent persistent setup to `prepare` without discarding existing behavior or duplicating the patch command. The operation must work immediately and after reinstalling dependencies. Account for package-manager lifecycle execution in the operation order.

The integration patches installed tooling, so this slice requires command execution as well as config edits. Follow the [upstream Oxlint setup guide](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md) and the installed release's compatibility constraints; do not assume config entries alone enable the rules.

Command:

```bash
tamo add effect-oxlint
```

Expected behavior:

1. Inspect the target, installed prerequisites, and compatibility.
2. Inspect actual config and scripts; calculate additive edits and installation/patch commands.
3. Show the complete plan, including any blocking conflicts and external command effects.
4. Stop for `--dry-run`; otherwise obtain confirmation or honor `--yes`.
5. Recheck inputs, then execute the planned operations sequentially.
6. Validate the effective integration and report the result.
7. On a second run against unchanged, successfully configured state, propose no mutations.

This is the first architecture test.

#### Acceptance criteria

- Dry-run changes no project files and runs no installation or patch commands.
- Existing rules, comments, unrelated settings, and scripts survive application.
- Both upstream Effect rules and the custom Layer rule are executable, including the intended test/script exception.
- Required conflicting settings, incompatible versions, and unsupported config arrangements block mutation.
- Changes to inspected inputs invalidate the reviewed plan.
- A second successful run produces an empty mutation plan, including no redundant install or patch.
- Execution/validation failures report completed mutations and remaining work; rollback is not promised.
- Plans and results are available as structured JSON independent of CLI presentation.
- Fixture tests establish these behaviors before Tamo is exercised on its own repository.

#### Deferred from Slice 1

General anti-slop rules and complexity are independently selectable lint preferences, not implied by `effect-oxlint`. Their proposed follow-up scope is recorded in `PARKING_LOT.md`.

Also defer workspace discovery, feature dependency graphs, extension discovery, generic config handlers, agent-assisted operations, provenance, rollback, and plan persistence. The rest of V1 does not need to be scaffolded to finish this slice.

### Slice 1.5: Pack (implemented 2026-09-05)

The first vertical slice of the revised model: `inspect → pack → preset`. It proves that reusable setup can be captured from an ordinary project without extensions, snapshots, or project metadata.

Command:

```bash
tamo pack web [--cwd path] [--include path]... [--exclude package]... [--from candidate.json] [--force]
```

Semantics:

- **Inspection reuse.** The candidate is built from the same factual inspection exposed by `tamo inspect`. No separate scanner.
- **Suggestions, not snapshots.** Manifest dependencies are suggested into the candidate; `--exclude` drops some. Application source is never captured automatically; files enter only through explicit `--include` (a path may be a file or a directory).
- **Safety boundary.** Secrets, generated output, dependency directories, caches, VCS state, and lockfiles are never captured, and `--include` of them is rejected. The denylist is small and explicit; it is not a claim of universal secret detection.
- **No source mutation.** Pack reads the project and writes only `<Tamo home>/presets/<name>.json`.
- **Review before save.** Interactive confirmation, or `--dry-run`/`--json` candidate output for agent review. An agent can edit the JSON candidate and save it with `--from <file>`; the edited candidate passes the same validation and policy.
- **Predictable repetition.** Repacking over an existing preset is blocked unless `--force`; a repack rebuilds the candidate from the current project and does not silently merge the old preset.
- **Noninteractive contract.** `--json` statuses: `dry-run` (exit 0), `confirmation-required` (exit 2, no write), `saved` (exit 0), `blocked` (exit 1).

The implemented preset schema is exactly: `name`, `packageManager`, `dependencies`, `devDependencies`, and `files` — an array of `{ path, contents }` seed entries at project-relative paths (included directories expand into their contained files; empty directories are not represented). Unknown keys are rejected so the schema can evolve deliberately. Seed paths pass the same denylist and boundary rules at both pack and replay time, so hand-edited presets cannot smuggle secrets or manifest overrides. `.env.example` is deliberately capturable as reusable seed content; `.env` itself never is.

Not solved by this slice, deliberately: upstream CLI steps (e.g. `shadcn init`), extension references in presets, version-freshness policy (captured versions are stored verbatim), Rust/Cargo inspection, workspace targets, and `create`.

### Slice 2: Create default web project

Command:

```bash
tamo create hello --preset web
```

Basic replay is implemented (see section 5.1): manifest, seed files, and a planned install, all through the shared plan/execution runtime. Still ahead for framework-heavy stacks: upstream CLI steps and extension references in presets — without them a replayed `web` preset is dependency-complete but unscaffolded (no `shadcn init`, no route generation). Temporary per-project overrides (`--with`, `--without`) must not mutate the stored preset.

Prefer official framework CLIs.

### Slice 3: Mixed monorepo

Example:

```bash
tamo create workspace --preset monorepo
tamo add web --at apps/web
tamo add gpui --at apps/desktop
tamo add effect --to packages/core
```

The repository may contain both Node and Rust projects.

Tamo should detect and operate on each project independently while understanding the workspace layout.

## 16. Non-Goals for V1

Tamo must not become:

- a package manager, build system, or task runner
- a universal framework registry or a giant collection of per-library integrations
- a replacement for coding agents, or a tool that requires one
- a requirement for projects to function (no project-level Tamo manifest)
- a desired-state owner like projen
- a template engine that blindly snapshots repositories

V1 is also not trying to provide:

- a GUI
- a public marketplace
- hundreds of built-in technologies
- perfect arbitrary-project adoption
- automatic replacement between every tool
- universal migration support
- complete config-language coverage
- a universal AST transformation engine
- permanent ownership of generated projects

These ideas may be explored later.

See `PARKING_LOT.md`.

## 17. Architectural Tests

Use these questions when evaluating design changes.

### 16.1 Unknown technology test

Can someone add support for a technology Tamo Core has never heard of without changing Tamo Core?

The answer should usually be yes.

### 16.2 Escape hatch test

Can an extension drop to lower-level operations when higher-level Tamo helpers are insufficient?

The answer should be yes.

### 16.3 Ownership test

If Tamo is uninstalled, does the project remain normal, understandable, and usable?

The answer must be yes.

### 16.4 Existing config test

Can a developer manually change ecosystem-native configuration without Tamo treating the project as invalid?

The answer should be yes.

### 16.5 Agent test

Can a coding agent discover what Tamo supports and plan an operation without reading a large prose document?

The answer should be yes.

### 16.6 Built-in parity test

Could a third-party extension implement something structurally equivalent to a built-in feature using public APIs?

The answer must be yes.

### 16.7 No per-library extension test

Does an ordinary dependency or a straightforward official CLI require an extension or any Tamo Core change to appear in a preset?

The answer must be no.

### 16.8 No project manifest test

Can `inspect`, `pack`, presets, and extensions operate on a project without creating or reading a project-level Tamo metadata file?

The answer must be yes.

## 18. Open Questions

Resolve these through implementation experience where possible:

- ~~Project metadata format: JSON, JSONC, or YAML?~~ Superseded: projects carry no Tamo metadata (section 11).
- ~~Exact extension loading mechanism.~~ Developer-home modules implemented; packaging/discovery remain open.
- Version freshness: presets currently store manifest-declared versions verbatim; whether `create` should re-resolve, pin, or ask is unresolved.
- How presets reference upstream CLI steps (e.g. `shadcn init`) and extensions; both are needed before `create` works for real stacks.
- Temporary override syntax and semantics for `create` (`--with` / `--without`).
- Whether `add` should also create new workspace projects or whether project creation needs a separate command.
- How much provenance Tamo should record for applied changes.
- How user-modified values should be handled when a preset later changes.
- How agent-assisted operations are represented in `--json` plans.
- Whether extension versioning belongs in V1.
- How local and package-distributed extensions are prioritized.
- Conflict resolution for later update/composition workflows; Slice 1 blocks on differing required values.
- Preset composition, forking, and sharing (two presets sharing most setup currently duplicate content).

## 19. V1 Success Criteria

Tamo V1 is successful if it measurably reduces repeated setup instructions to coding agents.

A good V1 should make interactions like these routine:

```text
"Create my normal web project."

"Add Effect here."

"Add my Effect Oxlint setup."

"Create a monorepo with a web project and a GPUI desktop project."
```

The agent should be able to translate those requests into Tamo operations with minimal additional stack-specific prompting.

Tamo should make the common path fast and consistent without preventing developers or agents from editing the underlying project directly.
