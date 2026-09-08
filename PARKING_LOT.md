# Tamo Parking Lot

> Deferred work beyond Slice 1, plus ideas excluded from V1.

This file preserves useful ideas without turning them into current implementation requirements.

The sections below distinguish follow-up work from longer-term possibilities. Items move into the active implementation scope only when real usage or an explicit scope decision justifies them. Broader V1 direction remains in `SPEC.md`; it is not a prerequisite for Slice 1.

> **Architecture revision (2026-09-06).** [SPEC.md section 0](SPEC.md#0-current-canon-native-artifacts-and-artifact-handlers) is the current canon: recipes compose native artifacts; artifact handlers expose semantic knowledge through structural helpers; Core coordinates identity, customization, planning, and execution. The bounded handler experiment (SPEC 0.11) is implemented; the broader handler/recipe architecture around it remains proposed. Older extension-marketplace and built-in-precedence ideas below are explicitly superseded history, not future requirements.

## Next Experiment: Artifact-Handler Customization

Implemented 2026-09-06 as the bounded experiment owned by [SPEC.md section 0.11](SPEC.md#011-next-experiment--implemented-as-a-bounded-experiment-2026-09-06); its outcome and acceptance-evidence results are recorded there. Open handler questions below still apply after the experiment.

## Next Candidate: Effect-Oxlint Recipe Migration

Implemented 2026-09-06 as the second bounded experiment; its parity evidence and the recorded contents of the remaining executable residue are documented in [SPEC.md section 0.11](SPEC.md#011-next-experiment--implemented-as-a-bounded-experiment-2026-09-06). The legacy `add effect-oxlint` implementation has been deleted after parity (`add effect-oxlint` now routes through the recipe path); recipe storage and the final executable-behavior abstraction stay open.

## Artifact Handlers: Questions After the Bounded Experiment

- Artifact storage/contribution layout and compatibility with today's flat preset schema; no forced preset-to-recipe code or storage rename.
- Handler applicability, competing artifact claims, and coordination between generic file inventory and semantic application so one artifact does not receive competing writes.
- Stable selector/interface evolution, stale references, absent-entry semantics, and ergonomic CLI selectors without arbitrary JSON-path mutation or domain `kind` fields.
- Preservation-aware codecs, cross-artifact validation, and composition of overlapping semantic plans. Sibling order must not silently discard changes.
- Keyed-set helpers only when real native collections need them; universal ordered-list editing and a tree language are not goals.
- Reusable conformance fixtures and agent-generated handler authoring. Tests should prove structural correctness and claimed preservation/reapplication behavior; trusted executable code remains outside any sandbox guarantee.
- Input checks versus post-application verification, and clear unsupported-state reporting when effective config cannot be derived safely.

## Shareable Collections (Deferred)

A future GitHub collection may contain recipes, native artifacts/assets, and custom handlers/planners. Personal or first-party opinions use the same semantics as any other collection; there is no canonical Core Effect/web/Rust setup. Unknown libraries do not require one handler per library.

Open questions: local installation layout, origin/revision identity, updates, editable forks versus derivation through explicit saved customizations, and trust in executable implementations. Remote installation is not part of the next experiment. Do not introduce implicit built-in/organization/user precedence to answer these questions.

## After Slice 1: General Lint Defaults

Keep general TypeScript lint preferences independently selectable from Effect lint preferences. Later personal defaults can compose them without making Effect a prerequisite for general rules or introducing new core concepts.

The following candidates were reviewed on 2026-09-05 for Tamo's general lint defaults:

- `no-chained-type-assertions`
- `no-widen-then-assert`
- `require-safety-comment-for-type-assertion`
- `no-unknown-type-aliases`
- `no-module-mocking`, as a personal testing policy
- `oxlint-plugin-complexity`, initially using cyclomatic 20, cognitive 15, and `minLines: 10` settings

Validate these choices on representative code before enabling them broadly. Complexity findings should prompt review, not mechanical helper extraction. A safety comment is a review aid, not proof. Warning severity still fails a lint command using `--deny-warnings`.

Tamo's own repository now runs the approved subset as of 2026-09-05 (dogfooding): the five general anti-slop rules and `oxlint-plugin-complexity` at cyclomatic 20, cognitive 15, `minLines: 10`, vendored under `.config/oxlint/plugins/anti-slop/`. The initial findings (planner complexity and one missing `SAFETY:` comment) were resolved by decomposition, not suppressions. This does not implement the general lint *feature*; installing these rules into target projects remains deferred.

Do not import the entire anti-slop plugin configuration unchanged:

- `no-unknown-parameters` currently rejects valid parser inputs and exempts a parameter based only on the name `cause`.
- `no-runtime-typeof` bans legitimate narrowing by default; its type-guard option does not cover every valid use.
- `no-known-value-widening` also flags anonymous object contracts and `Record` targets; narrow its intended scope before adoption.
- `no-unsafe-dictionary-type` and `no-unknown-returns` need to accommodate parsing and generic infrastructure.
- `no-object-parameters` bans the broad TypeScript `object` type, not object-shaped arguments; evaluate it as an application-code policy.
- `no-reflect-get` and `no-reflect-apply` need consideration for legitimate proxy/instrumentation code.
- `no-conditional-empty-object-spread` is an optional style preference.
- Leave `no-shape-in-symbol-names` disabled; substring matching also rejects legitimate domain terms and external API names.

For Effect, reconsider `no-service-constructor-imports` only after improving detection. It currently matches relative named imports beginning with `make` followed by an uppercase letter, without establishing that they construct Effect services. It can reject ordinary helpers and miss package-alias imports.

The custom `no-layer-in-service-class` rule is already in Slice 1; it is not deferred with these general rules.

## After Slice 1: Composition and Discovery

Preset application exists in first form (2026-09-05): `tamo create <dir> --preset <name>` replays package manager, dependency sets, and inline seed content into a new ordinary project. Composition and temporary customization now follow the proposed artifact/selector direction in SPEC section 0. Exact CLI syntax, general actions, global preferences, workspace discovery, and Rust/other-ecosystem support remain deferred. Extension dependency resolution is no longer the organizing model for recipe composition.

The 2026-09-05 model revision settled the storage side: global developer state (presets, extensions) lives under `TAMO_HOME`; the earlier project-level `tamo.json` extension mechanism was removed because it made projects Tamo-aware. Home-loaded extensions were later removed with the Extension architecture. Still deferred: workspace discovery.

## Strict Lint Profiles and Debt Tracking

A separate strict configuration could add upstream `antipattern`, `effect-native`, and `style` presets, with script exceptions and recorded lint debt. This is a possible later personal profile, not the default `effect-oxlint` slice.

Do not copy debt snapshots or audit scripts between unrelated projects. General strictness, per-project exceptions, and debt tracking need their own justified scope.

## GUI / Project Manager

Possible desktop or web UI for selecting reusable setups and applying reviewed changes to ordinary projects. Projects never need to become Tamo-aware.

Potential capabilities:

- list known projects
- show detected project structure
- visualize workspace/project graph
- display presets and features
- inspect current configuration
- show drift from current defaults
- add/remove features
- change presets
- review plans before applying
- show command history
- surface unsupported/manual operations

Architectural implication worth preserving now:

- Tamo Core should expose structured data independent of the CLI.
- `--json` should remain first-class.
- CLI, agents, and a future GUI should share the same engine.

Do not build the GUI in V1.

## Project Registry

Potential local registry of projects created or adopted with Tamo.

Could later power commands such as:

```text
tamo projects
tamo projects add
tamo projects remove
tamo projects open
```

Open questions:

- explicit registration vs filesystem discovery
- moved or renamed projects
- storing absolute paths
- multi-device synchronization

## Community Extension Registry (Superseded Direction)

The extension-centric product and per-technology registry framing below is retained as history. Shareable collections above supersede it; these examples are not an implementation roadmap.

Potential public ecosystem for Tamo extensions.

Examples:

```text
@tamo/biome
@tamo/tauri
@someone/tamo-bevy
```

Possible later commands:

```text
tamo extension search
tamo extension add
tamo extension update
```

Avoid designing a registry protocol until local/package extensions prove useful.

## Extension Marketplace (Superseded Direction)

Retained as historical brainstorming. Discovery may eventually present recipes and their derived inventory; a feature/detector/plugin marketplace is not the current product model.

Potential UI or website for browsing features, presets, detectors, and config handlers.

Possible metadata:

- supported versions
- compatibility
- documentation
- maintainer
- last validation date

Not required for the initial open-source release.

## Advanced Existing-Project Adoption

Potential deeper analysis of arbitrary repositories:

- confidence-based feature detection
- custom workspace structures
- nested workspaces
- nonstandard manifests
- mixed package managers
- source-code-based inference
- agent-assisted detection

V1 should support obvious manifest-driven cases first.

## Drift and Reconciliation

Potential future commands:

```text
tamo diff
tamo reconcile
tamo sync
tamo status
```

These could compare a project's current inspection against a preset or current defaults — e.g. answering "how is this project different from my normal web setup?" The comparison consumes the same factual inspection that `pack` uses; no separate scanner.

The V1 `status` direction depends on defined preset-application semantics and is deferred.

Constraint: Tamo must not become the authoritative source of truth for ecosystem-native config.

## Upstream CLI Steps in Presets

The current preset schema cannot record "run `shadcn init` with these choices." Basic captured replay already works; optional ordered actions are needed when rerunning an upstream process itself matters. Artifacts and actions may coexist, but action inputs must not duplicate native configuration merely to fit a step schema. Pack captures state and does not infer generating commands, versions, or options from files.

Commands can create outputs that later semantic planning cannot inspect in advance. Define explicit inspection/replanning/review checkpoints before claiming concrete downstream diffs. Artifact/action collisions, version freshness, and retry behavior remain open; no general workflow engine is required by the handler experiment.

## Version Freshness

Presets store manifest-declared versions verbatim at pack time; they age. Whether `create` should pin exactly, re-resolve to latest compatible, or ask is unresolved. Note also that repacking rebuilds the candidate from the current project rather than merging the previous preset, so a project can be deliberately re-captured to refresh a preset.

## Provenance

Potential record of which feature introduced which configuration.

Could help distinguish:

- feature defaults
- project-specific edits
- manual overrides

Do not add complex provenance until update workflows actually require it.

## Setup Updates

Potential support for explicitly applying newer saved setup choices to existing projects. Recipe updates do not silently update native project files.

Example:

```text
tamo update effect-oxlint
```

Needs a better provenance/update model first.

## Tool Replacement / Migration

Examples:

```text
Oxlint -> Biome
pnpm -> Bun
Vitest -> another runner
```

A migration may require dependency changes, config conversion, script changes, CI updates, and manual review.

Tamo must be able to report partial or lossy migrations instead of pretending every conversion is safe.

## Remove Applied Setup

Potential:

```text
tamo remove effect-oxlint
```

Safe removal is harder than addition because files/settings may be shared or manually changed.

Omitting an entry from a reusable setup is not authorization to remove it from an existing project. Explicit project removal or disabling requires semantic planning and review.

Do not make arbitrary removal a V1 requirement.

## Remote Presets

Potential presets stored in Git repositories, npm packages, URLs, or organization registries.

Useful later for teams.

## Preset Sharing

Possible:

```text
tamo preset export
tamo preset import
```

Could support stack sharing without requiring a full extension package.

Forking a preset is deliberately trivial today: presets are plain JSON files under the Tamo home, so copying one under a new name already works. A dedicated command only becomes worthwhile once preset management commands exist.

## Create-Time Overrides

Temporary per-project variation — "my normal web project but without shadcn", "my web preset plus SQLite for this project." The stored preset must never change from an override. Basic `create` exists; exact CLI syntax remains open. Invocation and saved-parent customization must reuse the same structural mechanism and derived inventory described in SPEC section 0, including for `add`. Older `--with`/`--without` sketches are not a settled interface.

## Lockfile

Potential Tamo lockfile for resolved extension versions, feature versions, preset versions, and integrity hashes.

Only needed if reproducibility becomes a real problem.

## Additional Artifact Formats

Only when real usage justifies semantic handling beyond the generic whole-file fallback, consider preservation-aware support for:

- JavaScript config
- TypeScript config
- XML
- INI
- HCL
- arbitrary language ASTs

Do not attempt universal config mutation in Core or make this list a parser-registry roadmap. Handler helpers expose structure without Core understanding the ecosystem; arbitrary files remain useful without a semantic handler.

## Agent-Assisted Operations Protocol

Potential formal protocol where Tamo returns semantic edits to the calling coding agent.

Example:

```json
{
  "type": "agent-edit",
  "file": "vite.config.ts",
  "intent": "Add the Cloudflare plugin while preserving existing plugins and custom configuration.",
  "validate": ["pnpm typecheck"]
}
```

This could become a major differentiator.

Slice 1 only reports unsupported configurations. It does not execute agent-assisted operations.

## Transactions and Rollback

Potential application model:

1. create plan
2. snapshot affected files
3. apply operations
4. validate
5. rollback on failure

Worth revisiting once Tamo performs larger mutations.

Slice 1 still checks that reviewed inputs are current and reports partial application accurately. Those requirements do not imply automatic rollback or an atomic transaction across external commands.

## Plan Persistence

Potential:

```text
tamo plan save
tamo plan apply
```

Not needed while plans are simple and interactive.

## Project History

Potential history of Tamo operations such as:

```text
added effect-oxlint
added cloudflare
created apps/web from web preset
```

Avoid turning this into a source-control replacement.

## Organization / Team Policies (Old Precedence Superseded)

The implicit hierarchy below is retained as history, not current architecture. In particular, privileged Tamo built-in opinions are rejected. Future team setups can use explicit collection references and derivation; enforcement and precedence beyond that remain unscoped.

Potential configuration layers:

```text
Tamo built-ins
  ↓
organization policy
  ↓
user defaults
  ↓
project choices
```

Only relevant if Tamo expands beyond personal tooling.

## GUI Preset Builder

Potential visual preset composition:

```text
web
  + TanStack Start
  + Tailwind
  + shadcn
  + Oxlint
  + Vitest
```

Could be useful when the feature ecosystem becomes large.

## Compatibility Knowledge

Potential richer metadata:

- minimum/maximum versions
- known conflicts
- tested combinations
- warnings
- environment requirements

Avoid promising universal compatibility certification.

This does not defer the concrete compatibility checks required by the `@effect/tsgo` Oxlint patch in Slice 1.

## Automated Compatibility Testing

Potential extension CI matrices for known combinations.

Useful for a larger public extension ecosystem, not V1.

## Tamo-Owned Starter Repositories

Potential official examples generated from Tamo presets.

Useful for docs/testing without making templates the core architecture.

## Cloud-Synced Personal Defaults

Potential optional synchronization of user presets/config across machines.

Not relevant to local-first V1.

## AI-Native Preset Creation

Potential workflow:

```text
"Save the current setup as my new web default."
```

The deterministic primitives now exist: `tamo inspect --json` gives the agent facts, and `tamo pack <name> --dry-run --json` plus `tamo pack <name> --from candidate.json --yes` let an agent review and save an edited candidate. What remains agent-side is judgment — distinguishing reusable setup from application-specific state beyond the small explicit denylist. A smarter interactive pack UI could revisit the same review flow without an agent.

Useful after detection matures.

## Auto-Suggest Missing Features

Possible `status` behavior:

```text
Effect detected.
Your normal Effect setup also includes effect-oxlint.
Add it?
```

Useful if it remains quiet and never mutates automatically.

## Smart Project Classification

Potential hints such as:

- frontend app
- library
- service
- worker
- CLI
- desktop app

These should remain hints/preset suggestions, not rigid Tamo Core classes.

## Open-Source Contribution Model (Historical Layout Sketch)

The layout below predates the artifact model. It is not a requirement to split packages or create privileged built-ins. Keep one package until concrete distribution or ownership needs justify extraction.

Possible repository shape:

```text
packages/
  core
  cli
  builtins

extensions/
  ...
```

Revisit only after local recipe/handler use establishes a concrete distribution or ownership need.
