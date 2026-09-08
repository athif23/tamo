# Tamo Specification

> Status: Draft  
> Scope: V1  
> Working name: Tamo

Section 0 is the current product and architecture canon. It supersedes conflicting earlier design proposals without changing the implemented contracts in section 15. The bounded artifact-handler experiment in section 0.11 has been implemented and evaluated; the broader handler/recipe architecture around it remains proposed.

Slice 1 is implemented as one pnpm package. See `README.md` for supported configuration arrangements, CLI usage, and verification commands. Broader V1 sections remain a draft.

> **Historical model revision (2026-09-05), refined by section 0 on 2026-09-06.** A stress test of 25 real workflows moved Tamo away from an extension-centric integration registry toward user-owned setup memory. The following records that revision; its flat preset schema remains implemented, but its suggested extension references/options are not the new recipe schema. Key settlements:
>
> - A preset is a reusable setup *recipe* (package manager, dependencies, explicitly selected reusable files; later: upstream CLI steps, extension references, options), **not** a list of extension IDs and **not** a project snapshot.
> - Ordinary dependencies and straightforward official CLI invocations need **no** extension. Extensions are the escape hatch for reusable custom behavior that generic primitives cannot express.
> - Projects carry **no** Tamo metadata. The project-level `tamo.json` extension mechanism is superseded; extensions load from the developer's Tamo home, like presets.
> - `inspect` is the factual foundation; `pack` turns an inspection into a reviewed preset. Global state lives under an isolatable `TAMO_HOME`.

## 0. Current Canon: Native Artifacts and Artifact Handlers

> **Terminology settlement (2026-09-06).** The target model has exactly these nouns: a **Recipe** is the user-facing reusable setup/opinion; an **Artifact** is native setup state used by recipes; a **Handler** is reusable, shareable semantic knowledge about an artifact type; **Core** owns recipe resolution, instance/artifact identity, temporary and persistent customization resolution, planning, and execution. **Plan** and **Operation** remain the runtime primitives. `preset`, `extension`, and `feature` are **not** target product abstractions. They name removed implementation: `preset` code/storage was the predecessor to recipes until durable recipe storage lands; the extension interface/loading and `src/features/effect-oxlint` were deleted after the recipe path demonstrated parity, and their behavior is preserved through recipe-path regression and integration tests — not through a retained oracle. Recipes still need a way to perform executable behavior that artifacts and handlers cannot express (e.g. `effect-tsgo patch`, compatibility checks, behavioral probes); the final abstraction, API, and name for that capability are **open** — do not canonize a new noun for it, and do not treat `extension` as that noun.

### 0.1 Status and authority

This section separates proven behavior from the next architectural direction. Older extension-oriented examples are implementation history or deferred proposals, not instructions to rebuild that model. `README.md` describes runnable behavior. `PARKING_LOT.md` records deferred work, not requirements for this experiment.

| Status | Scope |
| --- | --- |
| Implemented and dogfooded | `inspect`, `pack`, preset storage (legacy predecessor of recipes), basic `create`, `add` through the recipe path, `TAMO_HOME` isolation, read-only planning, sequential runtime execution, JSON/dry-run/confirmation, input rechecks, and partial-failure reporting. |
| Proven bounded replay | One Node/pnpm project → reviewed pack candidate → saved preset → new usable ordinary project. Seed entries carry file contents; directories expand into files. Capture/replay enforce the safety policy, including allowing `.env.example` and denying real `.env`, credentials, and path escapes. |
| Removed capability (Slice 1, deleted after parity) | Effect Oxlint integration, formerly through the extension interface (`src/features/effect-oxlint`, now deleted): compatibility checks, preserving JSONC edits/comments and unrelated settings, tooling patch/setup, custom Layer lint rule, conflicts, idempotence, and behavioral validation. Behavior is preserved through the recipe path (see 0.11) and its regression/integration tests; no oracle implementation is retained. |
| Implemented bounded experiment | SPEC 0.11 artifact-handler customization: one keyed/map selector helper, package-manifest and Oxlint handlers, shared `omit`, instance-addressed resolution through one Core path over in-memory recipes. |
| Current architectural direction, not implemented | Recipes assembled from native artifacts as the general model, durable recipe storage, derived inventory surfaces, deep composition, generic whole-file fallback interplay, and extending handlers beyond the 0.11 experiment. |
| Deferred or open | Exact storage and authoring interfaces, general actions/workflow, remote collections, other ecosystems, richer selector collections, migrations, and remaining questions in 0.10 and `PARKING_LOT.md`. |

The current preset schema still stores `name`, `packageManager`, dependency maps, and inline seed files. Preset code and storage are the implemented predecessor to recipes, kept until recipe storage is designed; this revision does not migrate them or rename code/storage from `preset` to `recipe`. The extension interface and the legacy Effect-Oxlint implementation have been removed. Known replay omissions such as scripts and other manifest fields remain limitations, not fields the runtime may invent.

### 0.2 Product definition and motivating flows

Tamo is a personal library of reusable setup intent for developers and coding agents. It remembers what a developer normally means by “add Effect,” “create my normal web project,” or “use my Rust setup,” and resolves saved choices into reviewed changes against the project that actually exists.

The agent contributes judgment and natural-language interpretation. Tamo contributes structured reusable setup, deterministic resolution, customization, planning, and execution. It also works without an agent. Deterministic resolution and ordered execution do not promise byte-identical results from arbitrary external commands or changing registries.

Projects remain ordinary projects. Native files stay authoritative; there is no required project-level desired-state manifest, implicit ownership, or obligation to keep using Tamo. Changing saved defaults does not change existing projects.

**Add Effect.** A saved Effect setup may include Effect, tooling, preferred Oxlint integration and rules, the custom Layer rule, and patch/setup behavior. Discovery should let an agent or user inspect and choose that associated setup rather than merely install the package. Natural-language matching remains agent judgment; the CLI must make discovery and selection usable without an agent.

“Add Effect, but don't include `strict-effect-provide` this time” customizes only the invocation. “Remove it from my normal Effect setup too” explicitly changes saved reusable state. Neither operation silently implies the other.

**Composition.** `web → effect → effect-oxlint` can reuse the same setup at different scopes. If standalone Effect contains A B C, web can omit B and add D for its included instance. When the referenced child later gains E, resolving web should yield A C D E. Keep the reference plus customization rather than freezing the whole child into a copied snapshot. Deeper nesting follows the same mechanism; broken identities or incompatible changes must surface rather than be guessed away.

**Granularity.** `effect`, `effect-oxlint`, `web`, and `rust` are all reusable setups. Separate a setup when independent reuse, customization, or composition is useful; otherwise keep it embedded. Users should not need implementation categories to select their normal setup.

### 0.3 Settled rejection of older models

- Native artifacts carry configuration. Do not duplicate their contents in a universal Tamo schema (`oxlintRules`, `cargoDependencies`, `viteConfig`, etc.) or in `steps[].inputs.rules`, `steps[].inputs.plugins`, or `steps[].dependencies` merely to mirror native fields. The existing flat preset representation is compatibility history, not the target architecture.
- Ordinary libraries do not each need an extension. Unknown npm libraries must remain usable without changing Core; official CLIs and artifacts cover much of the long tail.
- Core supplies no privileged opinionated Effect, web, or Rust defaults. Personal and future shareable collections may contain opinions, including first-party collections with the same semantics as anyone else's. The currently bundled Effect integration is proven implementation, not a mandate for canonical Core preferences.
- Selectors do not require domain taxonomy such as `kind: rule`, `kind: plugin`, `kind: dependency`, or `kind: crate`. Their meaning belongs to handlers.
- Arbitrary JSON-path patching, universal config parsing, a general ordered-list/tree language, and a giant plugin framework are not the customization model.
- `preset`, `extension`, and `feature` are legacy implementation names, not target product abstractions. New design work uses the recipe/artifact/handler/Core vocabulary; see the terminology settlement at the top of this section.

### 0.4 Recipes, artifacts, and responsibilities

A **recipe/setup** supplies identity and composition of native reusable artifacts, persistent customizations, and optional actions where artifacts alone are insufficient. A **native artifact** carries actual setup state: a `package.json`-shaped contribution, Oxlint config, `Cargo.toml`, `tsconfig.json`, utility source, directories, or arbitrary files. A contribution need not copy project-specific identity or every field of the original manifest; its shape and meaning remain native.

An **artifact handler** supplies reusable knowledge of selected artifact types. A handler is not recipe-specific: the same package-manifest or Oxlint handler serves any recipe carrying those artifact types, and a handler never encodes recipe-specific preference. A recipe expresses opinion/preference; a handler/planner supplies capability. Custom code remains author-facing plumbing rather than the normal user-facing object.

| Owner | Responsibilities |
| --- | --- |
| Handler | Identify supported artifacts; decode/encode; declare meaningful selectable structure; check adjusted artifacts and domain relationships; plan safe application; preserve unrelated native content/comments within its supported scope. |
| Structural helpers | Common inventory enumeration, keyed/scalar access and edits, selector addressing support, and structural/value validation. Handler authors should not reimplement these mechanics. |
| Core | Recipe composition, include-instance and artifact identity, customization ordering, immutable invocation resolution, combined inventory, planning coordination, and runtime execution. |
| Calling workflow | User prompting, pack review, recipe persistence, and command-level orchestration. These stay outside handlers. |

Handlers never execute their own planned mutations. Input/domain checking before planning is distinct from verification of the applied result. The existing read-only plan → reviewed operations → runtime → validation structure remains useful.

### 0.5 Small structural authoring interface

The proposed authoring library starts with keyed/map entries, scalar values, and normalized file paths. Prefer simple field declarations such as `mapField("dependencies")`, `mapField("devDependencies")`, and `mapField("rules")` where sufficient; callbacks are available only when the native structure needs them. These names illustrate the intended shape, not a finalized or available API.

Core knows that selectors are named and addressable, not what their names mean. Selector identities are a handler interface commitment. Addresses separate recipe/include instance, artifact, selector, and entry; do not parse domain meaning from a display string. For example, conceptually:

```json
{
  "instance": ["web", "effect"],
  "artifact": ".oxlintrc.jsonc",
  "selector": "rules",
  "entry": "effecttsgo/strict-effect-provide"
}
```

Entry names may contain slashes; structured identity avoids confusing them with nesting. Distinct include instances remain independently addressable. Reject cycles, ambiguous identities, and stale selector references visibly rather than silently choosing or deduplicating an instance.

Start without a universal ordered-list editor or tree language. A keyed-set helper may be added when a real native collection requires it. Folder selection can expand normalized descendant file paths; it does not require a general tree programming model.

### 0.6 Inventory and shared customization

Inventory is derived from native artifacts through handlers. An Effect setup can expose packages (`effect`, `@effect/tsgo`), explicit Oxlint rules and plugins, and files under `.config/oxlint/`. These are presentation labels and handler knowledge, not Core taxonomy or another handwritten configuration schema.

Use the same serializable customization mechanism for pack selection, saved customization of an included recipe, and temporary invocation customization. Only their source material, persistence, and lifetime differ. The rules are explicit:

- Include/exclude/customization supplied for a Tamo invocation is **ephemeral by default**: it exists only for that run. It is represented internally from CLI or agent parameters, not as a manually authored invocation file.
- Invocation customization **never mutates the saved recipe**.
- A customization becomes **persistent only when the user explicitly asks to modify the recipe**.
- Persistent recipe customization and temporary invocation customization use the **same underlying structural edit mechanism** and the same Core resolution path.
- Handlers are reusable across recipes and never encode recipe-specific preference; a customization adjusts a recipe instance, not handler behavior.

The preferred minimal structural edits are:

| Edit | Meaning in the adjusted reusable artifact |
| --- | --- |
| `put` | Ensure a keyed entry has the supplied value, inserting or replacing it. |
| `omit` | Exclude a keyed entry from the reusable contribution. |
| `set` | Replace an explicitly exposed scalar value. |

Include/exclude and add/remove UX should use these shared structural mechanics without domain-specific operation types. Exact syntax, absent-entry handling, and any preconditions remain to be tested; reset semantics and arbitrary nested JSON mutation are not assumed.

Resolve included recipes and their own customizations first, then enclosing instance customizations, then invocation customization. Work on adjusted in-memory artifacts without mutating saved inputs. Validate the final adjusted combination before planning; legitimate multi-edit changes should not fail merely because an intermediate state was inconsistent. Expose edit sources and resolved addresses for explanation without requiring permanent project metadata.

**Omission is not project deletion.** If a rule already exists in the target, omitting it from the recipe contributes no requirement for that rule. It does not authorize deleting or disabling it. Explicitly turning it off is a different semantic request for the relevant handler/planner and must appear in the reviewed plan.

Handlers check relationships such as “plugin X is absent but dependent rules remain.” Return actionable conflicts tied to selections; do not silently repair intent through cascading removals. Structural helpers cannot infer ecosystem relationships or whether removing an arbitrary utility file breaks imports.

### 0.7 Reuse across workflows and unknown artifacts

`inspect` remains factual: what is actually here. `pack` captures reviewed reusable parts of that state. `create` replays reusable setup into a new ordinary project. Handlers should reuse artifact knowledge across inspect, pack, customize, and plan; the workflows themselves remain outside handlers.

Pack primarily captures current state, not history. Generated files do not establish the originating CLI, version, options, or subsequent manual edits. Actions and composition can be explicitly authored later; do not infer executable workflows or original recipe ancestry from files alone.

Unknown formats remain useful through generic whole-file capture/replay, inclusion/exclusion, and directory-subtree selection. Conservative application creates missing files, leaves identical files unchanged, and reports differing content as a conflict. Fine-grained customization needs a suitable handler or an agent's explicit assistance. Unsupported/unparsed state is distinct from absence; unknown files are not a reason to grow a universal parser registry.

Generic file inventory and semantic handlers must not emit competing writes for the same artifact. Core coordinates a single application result or reports a conflict. Safe combination of overlapping semantic contributions is an open planning question, not permission for last-writer-wins behavior.

### 0.8 Artifacts, actions, and custom code

Captured results and ordered setup actions can coexist. A web recipe may contain package setup, `tsconfig`, `src/lib/`, and `.env.example`, plus an upstream initializer, custom semantic setup, formatter, and checks. Store results when those contents matter; store actions when rerunning the upstream process matters. Pack does not reconstruct those actions automatically.

An action must not silently overwrite a differing captured/generated artifact. Commands may produce outputs unavailable during initial planning. If later semantic edits depend on those outputs, the workflow needs explicit inspection/replanning and review boundaries; an initial dry-run cannot promise an exact unknown final diff. General workflow implementation remains deferred.

The existing Effect Oxlint integration (legacy Slice-1 implementation, not a permanent category) demonstrates why executable capability is still needed: version compatibility, targeted preservation, tooling patches, custom plugin setup, conflicts, and behavioral probes. Keep this capability while moving reusable opinion toward native artifacts. Do not make every recipe author implement executable code. The final abstraction, API, and name for recipe-carried executable behavior remain **open**; the legacy extension interface is not that answer and must not be established as a permanent category beside handlers.

Future collections may package recipes, native assets, and custom handlers/planners together. “Athif's Effect setup” is a collection's opinion, not a Core default. Remote installation and update behavior are deferred.

### 0.9 Agent-generated handlers and conformance

A future agent can encounter an unsupported artifact, read its documentation and project context, author a handler through the small helper interface, and check it against a reusable conformance harness. This makes later use deterministic without requiring Core changes for each format or library. The authoring interface should be small, explicit, and supported by concrete examples and fixtures rather than prose conventions alone.

The harness should eventually check stable inventory and unique addresses; immutable customization; preservation of unrelated content; omission limited to the selected entry; invalid adjusted setup rejected before planning; read-only planning and valid operations; and reapplication matching the handler's claims. Core should validate returned operation shapes, paths, identity/ownership conflicts, and reviewed input fingerprints.

Executable handlers are trusted code. Passing tests or accepting a read-only context does not sandbox TypeScript or prove absence of side effects. Keep input validation, conformance, and trust distinct.

### 0.10 Deferred decisions

The architectural division above is settled direction; exact implementation contracts remain experimental. Open questions include the final abstraction, API, and name for recipe executable behavior; artifact contribution/storage layout and compatibility with current presets; handler identification and competing claims; selector evolution, absent entries, and CLI syntax; cross-artifact checks; preserving encoders; safe combination of overlapping plans; and action/replan checkpoints. Distribution, revision selection, forks, freshness, and provenance remain deferred. See `PARKING_LOT.md`; none requires broad implementation before the next experiment.

### 0.11 Next experiment — implemented as a bounded experiment (2026-09-06)

Prove handler-based customization using one captured `package.json`, one captured Oxlint config, one keyed/map selector helper, a package-manifest handler, and an Oxlint handler adapted from existing work. Expose only `dependencies` and `devDependencies` from the manifest, and explicitly configured rules from Oxlint. Do not enumerate rules enabled only through upstream presets.

Use the same `omit` record shape and Core processing path, varying only address, to exclude one package and one explicit Oxlint rule. Exercise invocation edits and a minimal saved-parent/include fixture through the same resolver; do not build a general composition UI or remote system.

Acceptance evidence:

1. Saved artifacts remain byte-for-byte unchanged after customization.
2. Unrelated native content and supported comments survive adjustment and application.
3. Invalid adjusted combinations fail before project mutation.
4. Stale selectors fail visibly rather than becoming silent no-ops.
5. Identical edits supplied by invocation or saved parent produce the same adjusted result.
6. An unrelated new child entry survives a parent's omission when resolving again.
7. Plans use existing reviewed execution and preservation behavior, with focused fixtures for conflicts and repeat application where applicable.

The decisive test: can Core perform identical customization/composition mechanics for packages and Oxlint rules while knowing nothing about their meanings? If handlers reinvent enumeration, customization, or precedence, the helper is too weak. If Core understands package or Oxlint semantics, the abstraction is too leaky. Preserve the current working inspect/pack/create/add paths while testing this seam. General lists, implicit-rule expansion, workflows, other ecosystems, and remote installation are outside this experiment.

**Outcome (implemented 2026-09-06).** The experiment was implemented as `src/structure.ts` (the `mapField` keyed/map helper, generic over entry values), `src/handler.ts` (the handler contract: claim, adjust, validate adjusted, plan contribution), `src/handlers/package-manifest.ts` and `src/handlers/oxlint-config.ts` (exposing `dependencies`/`devDependencies` and explicitly configured top-level `rules` only), and `src/compose.ts` (in-memory recipes with child include, instance-addressed `omit` resolution innermost-first, and plan assembly). It answered the decisive test affirmatively: Core resolves saved-parent and invocation edits through one identical path carrying only structured addresses, while all package/Oxlint semantics live in the handlers. Application proved semantic rather than whole-file: handlers contribute additively into the target artifact, preserving unrelated fields and comments, and block visibly on differing values or unsupported target arrangements (inherited `extends`, config-changing overrides).

Measured against the acceptance evidence: saved recipes and artifacts stayed byte-for-byte unchanged (resolution works on copies); unrelated native content and JSONC comments survived adjustment and application; stale selectors, unknown instances, and unclaimed artifacts failed visibly with their structured address; identical edits through invocation and saved parent produced identical adjusted artifacts; a new child entry survived a parent's omission on re-resolution; and plans flowed through the existing reviewed runtime, with repeat application proposing no mutations. Acceptance item 3 (invalid adjusted combinations fail before project mutation) is **not meaningfully exercised**: the validation boundary is implemented — handlers validate adjusted artifacts before planning, and born-malformed artifacts are blocked there — but omit-only edits over dependency maps and explicit rules cannot turn a valid artifact into an invalid one, so no legitimate failing combination exists in this bounded scope. Whether to broaden the experiment or revise the criterion is left to the next canon revision. Recipes remain in-memory experiment fixtures, not a durable schema; preset storage and the working inspect/pack/create/add paths are untouched; CLI selector syntax remains open (section 0.10).

**Second bounded experiment: effect-oxlint recipe migration (implemented 2026-09-06, same day).** The legacy Slice-1 extension was reproduced as an in-memory recipe of three native artifacts (a `package.json` contribution carrying `scripts.prepare` and the integration devDependencies, an Oxlint config contribution, and the custom plugin source as whole-file content) applied through the shared package-manifest and Oxlint handlers plus Core's conservative whole-file fallback for the unclaimed plugin file, and a minimal recipe-carried executable behavior. Parity with the legacy `add effect-oxlint` path — since deleted — was proven at plan level: byte-identical write operations and identical command sequences on equivalent project state, identical blocking reasons across eleven conflict scenarios, zero operations in any blocked plan (true by construction: fragments are assembled only when no conflict exists), and no proposed mutations when the target already satisfies the contribution. Ownership stayed clean: the plugin file is written by Core's whole-file fallback, `scripts.prepare` persistence is manifest-handler knowledge, the recipe artifacts carry all Effect preference values, the handlers contain no Effect-specific logic, and the behavior contributes commands only — it is type-barred from artifact writes.

The executable behavior was then extracted behind a provisional internal seam (`RecipeBehavior`: optional `finalize` contributing conflicts/evidence/commands and optional `verify` checking the applied result; one per recipe; resolved adjusted artifacts supplied as planning context). Core owns tracked reads — target-relative `context.read()` and explicit `context.track()` both register into the reviewed inputs the runtime rechecks — and assembles artifact writes before behavior commands. A behavior-bearing instance anywhere in the include tree runs with its own resolved artifacts and structured instance identity; more than one behavior-bearing instance is an explicit blocking conflict, and cross-instance command ordering remains undefined. `verify` receives the behavior-owning instance's resolved intent (`cwd`, `instance`, resolved artifacts) and derives expectations from it, so intentional customization changes what verification demands instead of failing it; the type contract is precise — a RecipeBehavior cannot author WriteOperations, while CommandOperations may naturally have external filesystem effects when the runtime executes them. The seam is not a canonized product abstraction and has no storage/loading/distribution. The CLI's `add effect-oxlint` spelling resolves to the in-memory recipe; the legacy path was deleted after the cutover, and parity is held by recipe-path regression and CLI/integration tests. What remains in the behavior is the recorded input for designing the still-open executable-behavior abstraction: environment precondition checks, desired-version comparison against the installed tree, bounded inherited-config preset-rule conflict checking, native patch-state detection (binary hashing), the `pnpm install --ignore-scripts`/`effect-tsgo patch` orchestration with its ordering constraint, and the behavioral lint probe.

**Third bounded slice: durable single-include composition (implemented 2026-09-07).** `recipe.json` persists at most one child reference (`includes: [{ recipe }]`, no aliases) plus persistent omit customizations in exactly the in-memory shape (now carrying `op: "omit"`; no `put`/`set`, no compat for the earlier no-`op` form). Parents reference children — re-resolution after child-only changes yields the child's new state with no parent modification, proven by regression tests. Cycles, missing children, and stale addresses surface through the existing Core conflicts. Handlers gained contribution coverage for existing-target merges: contributed package.json fields outside dependencies/devDependencies/scripts (except target-owned name/version/packageManager) and Oxlint fields outside extends/plugins/options.typeAware/rules/overrides/jsPlugins block loudly when their values differ from the target, while identical values report as already-matched evidence; absent targets still materialize complete bytes verbatim. `tamo add` resolves durable home recipes through the Core path with a loud failure on built-in name shadowing. This slice proves durable references, persistent omits, and re-resolution only — not general composition, authoring UX, or multi-include.

**Fourth bounded slice: same-path composition with multiple includes (implemented 2026-09-07).** `recipe.json` accepts multiple distinct child references (no aliases; duplicate children under one parent fail loudly in Core resolution). The global duplicate-artifact-path rejection is gone: after persistent then invocation customizations apply to their specific instances, Core groups contributions by path and asks the claiming handler to combine each group through a new `combine` hook (already-resolved, already-customized contributions with instance provenance; one combined artifact plus evidence, or conflicts). Groups no handler combines dedupe when byte-identical and otherwise conflict explicitly — never last-writer-wins, and include order never resolves incompatible values. The package handler combines dependency maps, scripts (differing commands conflict; no shell composition), version/packageManager/name scalars, and other top-level fields (unique-or-identical survives, differing conflicts) order-independently and losslessly. The Oxlint handler merges rule and option keys on full-value identity, dedupes identical extends/plugins/overrides collections while conflicting on divergence (no positional union), unions jsPlugins by registration identity, and preserves-or-conflicts any other state the same way. Combination runs before target planning; conflicting combinations yield zero-operation plans. Behavior-bearing instances keep reading their own per-instance contributions while the combined artifact is what gets planned, so the Effect behavior still receives its own resolved intent, plans its commands after all writes, blocks the whole plan on behavior conflicts, and verifies against its own instance. Shared combination mechanics (owned-value unions, text-surgery placement) live in the structural helpers, not in Core — Core knows only paths and provenance. Out of scope as before, plus: aliases, duplicate includes, multi-behavior ordering, behavior persistence, command composition, put/set, and any ordering/precedence semantics.

**Fifth bounded slice: preparation checkpoint with explicit replan (implemented 2026-09-07).** `RecipeBehavior` gains an experiment-internal `prepare` hook that runs before same-path combination and artifact planning, for upstream commands whose generated state must exist first (SPEC 0.8). Preparation conflicts block with zero operations; preparation commands become a commands-only plan carrying `requiresReplan: true` while artifact planning and post-artifact behavior wait for a fresh replan; silence continues normally to a final plan with `requiresReplan: false`. Resolution is split so preparation observes resolved, customized per-instance contributions without triggering combination. A small Core orchestration (`applyRecipeWithReplan`) plans, reviews, and executes at most two stages — a failed or declined stage stops the sequence with no rollback, and a second preparation plan blocks instead of looping — and the `add` command drives it with independent review, confirmation, reporting, and verification per stage (`--yes` authorizes both; `--dry-run` shows only the knowable preparation plan; JSON exposes `requiresReplan` on the plan). Proven with a deterministic local initializer fixture: generated `package.json`/Oxlint state survives while combined recipe and sibling contributions merge onto it, preparation is state-gated so it plans once and never repeats, and failure semantics (failed initializer stops before replan; second-stage conflict after first-stage success leaves generated state in place) match the existing partial-application philosophy. Out of scope as before, plus everything in section 12 of the task: no shadcn/network tooling, persisted actions, multi-behavior ordering, rollback, checkpoint files, or general workflow machinery.

**Sixth bounded slice: real-ecosystem smoke with shadcn (run 2026-09-07).** The prepare → replan mechanism was exercised against pinned `shadcn@4.21.0` (`init --template vite`, fully noninteractive flags probed) as a manual opt-in script (`pnpm test:smoke-shadcn`), deliberately outside the deterministic suite. Stage 1 planned only the initializer with `requiresReplan: true`; after real execution, a fresh replan observed the generated Vite project and stage 2 wrote exactly two artifacts — the combined recipe+sibling `package.json` contribution merged onto generated state (react, tailwindcss, build script, project name preserved; vitest/clsx/test-script added) and a verbatim `.oxlintrc.jsonc` the template does not ship — with `requiresReplan: false`, followed by a zero-operation idempotent replan. `components.json` (the preparation gate) and `src/index.css` survived untouched. No Core, handler, or RecipeBehavior change was needed; the only real-world adjustments were experiment-local (accepting the installer's detected pnpm lockfile alongside npm's). Deterministic coverage of the experiment's gate, pinned invocation, and combination lives in the normal suite; the live CLI run stays manual.

**Seventh bounded slice: unambiguous multi-behavior instances (implemented 2026-09-07).** The blanket rule against more than one behavior-bearing instance is removed; Core now collects prepare and post-artifact fragments from every behavior-bearing instance and only blocks on genuine ambiguity. Prepare phase: any prepare conflict blocks with zero operations; silence from all hooks continues normally; exactly one command-producing instance yields the commands-only preparation plan (`requiresReplan: true`); more than one is an explicit conflict naming the producers. Post-artifact phase: every behavior plans against its own resolved contributions with commandless evidence preserved; any behavior conflict blocks the whole final plan; zero command producers means writes only, one producer means writes then its commands, and more than one is an explicit unsupported-ordering conflict naming the producers — never concatenation by traversal order, and blocked plans keep no artifact writes. Verification runs every defined verifier against its own instance identity and artifacts, aggregating failures without skipping instances. The single-checkpoint replan limit is unchanged. Proven with a deterministic three-child fixture (prepare-gated initializer child, post-artifact command child, artifact-only sibling) through full execution, plus producer-conflict tests for both phases and per-instance verification tests; the manual shadcn smoke gained a silent second behavior and still passes. Core learned only instance identity and command-presence counting — no Effect, shadcn, package, Oxlint, or ordering knowledge. Still out of scope: producer ordering, sequential checkpoints, DAGs, priorities, rollback, and behavior persistence.

**Eighth bounded slice: recipe-local durable Behavior modules (implemented 2026-09-07).** A recipe directory may carry an optional `behavior.mjs` beside `recipe.json` (presence means Behavior, absence means artifact-only); `recipe.json` stays limited to composition metadata and pack remains behavior-blind. The module default-exports exactly one `RecipeBehavior` value (`prepare`/`finalize`/`verify` only, each callable, at least one hook, unknown keys rejected), validated at the loading boundary. Core imports behavior modules demand-first for the selected resolution tree inside `planComposition`/`verifyComposition` — an unrelated broken recipe never blocks another composition — tracks each import as a reviewed input, and otherwise feeds the exact existing path with unchanged multi-behavior rules. `.mjs` was chosen over `.ts` because plain dynamic `import()` needs no flags or compiler: `.ts` loading works only for erasable syntax (a behavior author hitting `enum` gets a runtime import failure), which would bless a hidden language subset. Proven with durable fixtures: an Effect-style finalize/verify recipe (pinned preconditions checked against actual target state, state-gated command, intent-plus-effect verification), a prepare recipe driving the local initializer, and a three-child parent composing both plus an artifact-only sibling through both stages; invalid modules (syntax, missing/non-object default, unknown keys, non-callable hooks, zero hooks) fail loudly per selected recipe only. Real `tamo add` and `tamo create` (finalize-gated, empty-dep manifest for the offline install) both execute durable behavior with no CLI changes. One real finding: finalize hooks that precondition on target state cannot participate in create-into-empty-target planning — create-suitable behaviors must gate on their own effects instead. Trust boundary: recipe-local behavior is trusted local executable code, imported and executed during planning before operation confirmation; only the fixed filename under the resolved recipe directory is ever imported, symlinks rejected, nothing remote, no sandboxing or prompts. Still out of scope: registries, remote loading, sandboxing, signatures, behavior persistence formats beyond the module file, and provenance detection.

**Ninth bounded slice: durable-Behavior proof gaps (implemented 2026-09-07).** The production Effect behavior now runs through the durable module path: `behavior.mjs` re-exports the real `effectOxlintBehavior` (verified by import probe — plain dynamic `import()` of the `.ts` source needs no flags), so prerequisite/version checks, patch-state detection, tracked inputs, finalize commands, and behavioral verification execute identical code. Finalize planning rule canonized in Core: `finalize()` contributes operations that execute after artifact writes but is evaluated while the Plan is constructed, so hooks must use resolved recipe intent — not same-Plan on-disk state — for anything the Plan itself creates; the Effect `finalize` falls back to its own package.json/Oxlint artifacts when the target files are absent (genuine gaps like a missing pnpm packageManager still conflict). `tamo create` loudly blocks recipes whose plan requires preparation instead of silently executing the preparation Plan as final. Proven by planning-parity tests (durable vs in-memory operations identical on the same target), a finalize-before-writes invariant test, a create-preparation block test, a behavior-file mutation recheck test, order assertions on the create path, and an integration extension exercising the durable Effect recipe against the real installed project (dry-run parity plus verified `--yes`).

**Tenth bounded slice: staged `create` with prepare → replan support (implemented 2026-09-08).** `tamo create` reuses the one-checkpoint `applyRecipeWithReplan` orchestration shared with `add` instead of blocking on `requiresReplan`: stage 1 plans and reviews the initializer command only, then a completely fresh `planCreate` pass (reloaded recipes, re-materialized names, fresh snapshots and behavior binding) plans writes and finalize commands against the generated target. The initial guard still rejects pre-existing non-empty targets, but the stage-2 pass runs with `allowPopulatedTarget` inside the same in-memory workflow — no ownership metadata is persisted — while a target path that is a file still blocks. Prepare commands carry their own cwd (typically the existing parent workspace that the initializer populates as a named child); nothing in Core or create assumes they run inside the target. Create-specific package-name semantics are preserved on both sides of the merge: input-side `materializeName` stamps every artifact copy, and a create-owned output step stamps the planned package.json result (synthesizing the rename write when nothing else touched the manifest), because handler merging otherwise lets the generated name survive. The `pnpm install` step and name stamping apply to final plans only; unsettled second checkpoints block through the existing orchestration. Dry-run shows only the knowable preparation plan (`{ plan, status: "dry-run" }`, nothing created); `--yes` authorizes both separately reviewed stages; staged JSON reuses the per-stage `{ plan, result }` record convention. Failure semantics match the existing philosophy with no rollback: non-empty initial targets, failed initializers, stage-2 handler conflicts, second checkpoints, and failing finalize commands each stop honestly with generated state left in place. Proven deterministically (staged CLI end to end, all five failure shapes, dry-run honesty, behavior-file recheck, rename synthesis, no domain knowledge) and by a manual `pnpm test:smoke-shadcn-create` run driving the public create entry point against pinned `shadcn@4.21.0`.

## 1. Purpose

Tamo is a personal library of reusable setup intent for developers and coding agents. It remembers a developer's normal choices and resolves them into reviewed changes against the project that actually exists, while leaving native files authoritative. Section 0 defines the current architecture and its implementation status.

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
- **Preset** — legacy implemented predecessor of the recipe: a developer-owned, named, reusable setup stored in the Tamo home. The target abstraction is the recipe; preset code/storage remains until recipe storage is designed.
- **Pack** — deterministic capture: inspect a project, build a reviewed candidate, save a preset. Never mutates the source project.
- **Create** — produce a new ordinary project from a preset (basic replay implemented; richer composition deferred).
- **Add** — change an existing project by adding a reusable capability.
- **Extension** — legacy executable plumbing (plan/validate modules) for what generic primitives cannot express. Not a target product abstraction; the replacement seam for recipe executable behavior is open.
- **Plan** — a reviewed set of concrete operations before any project mutation.
- **Operation** — one write or command record executed by the runtime.

Detection and config editing are ordinary integration functions. Operations are operation records, not another extension lifecycle. Global developer state (presets, extensions) lives under the Tamo home directory, isolatable for tests through `TAMO_HOME`; a project never needs a Tamo manifest simply because Tamo touched it.

Higher-level concepts such as "web" or "Effect package" are presets, not core types.

### 2.4 No privileged opinionated Core setups

The currently bundled `effect-oxlint` implementation uses the same extension interface available to users. Preserve that working capability without treating its preferences as canonical Core defaults. Future opinionated recipes belong to personal or shareable collections using the same semantics as other collections (section 0).

Most technologies need no custom implementation: ordinary dependencies are native manifest contributions and framework scaffolding belongs to official CLIs. The existing extension interface remains supported while the small handler-authoring experiment tests the next abstraction; publishing a stable SDK is not required.

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

### 2.8 Native artifacts first, custom capability when needed

Support technologies actually used by the project owner through native artifacts, shared structural helpers, and official tooling. Handlers provide semantic knowledge where useful; custom executable behavior remains an escape hatch. An unknown library must work in reusable setups without changing Tamo Core or acquiring its own extension.

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

### 4.2 Extension (implemented custom-code plumbing)

This section documents the existing implementation contract — legacy executable plumbing awaiting eventual replacement by the still-open executable-behavior abstraction — not the central user-facing abstraction or proposed handler API. Recipes/setups and native artifacts are the current product direction in section 0.

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

The implemented preset schema (see the Pack Slice, section 15) is deliberately minimal: `name`, `packageManager`, `dependencies`, `devDependencies`, and explicitly selected `files` — seed entries carrying their contents inline (`{ path, contents }`), so replay never depends on the source project; included directories expand into their contained files at pack time. The workflow example above illustrates intent, not a target schema. Section 0 supersedes extending this flat representation into duplicated configuration under generic steps/options.

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

Implemented so far: `inspect`, `pack <name>`, basic `create <dir> --preset <name>`, and `add` with built-in or developer-home extensions, with the applicable flags below and basic help. Other commands in this section are deferred sketches, not a finalized recipe CLI. Temporary customization and `status` comparison remain deferred.

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

Changes an existing project by adding a reusable capability. Currently the thing added is an extension id (`tamo add effect-oxlint`). Applying saved recipes and invocation customizations to existing projects is proposed in section 0, not implemented by this command yet.

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

Lists discoverable recipes/setups; custom implementation discovery is author-facing plumbing. This command is deferred.

### 5.7 Show

```bash
tamo show <id>
```

Shows setup metadata and, in the proposed model, derived inventory. The historical extension-oriented example below is not an implemented command or final selector interface.

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

The actual Oxlint configuration lives in native `.oxlintrc.json` or `.oxlintrc.jsonc` artifacts. The former `features: [oxlint, effect-oxlint]` preference-list example is superseded by the artifact model in section 0; it is not a project manifest or target recipe schema.

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

### 8.3 Existing config helpers and proposed artifact handlers

Slice 1 needs targeted JSON/JSONC edits to `package.json` and Oxlint configuration, plus creation of the feature's local lint plugin files. These are integration helpers, not a public config-handler registry.

The shared artifact-handler interface in section 0 is proposed. Potential format support below is justified only by real reusable setup needs, not by a goal of completing an ecosystem registry:

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

## 10. Extension Loading (Implemented Plumbing)

This section records current executable-module loading — legacy plumbing, not a target product abstraction. Section 0 supersedes an extension-centric product model; it does not yet replace this implementation or define handler loading.

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

## 14. Initial Stack Interests (Historical Prioritization)

> **Superseded as a built-in roadmap (2026-09-06).** The list below records the owner's initial stack interests. It does not define canonical Core setups, require per-library implementations, or expand the next experiment. Section 0 places opinionated setups in personal/shareable collections.

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

The defaults below document the currently bundled personal Effect lint setup. They remain the implemented integration contract, not canonical Core preferences for future recipes. `effect-oxlint` is the current extension ID, not the npm package named `effect-oxlint`.

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

The original slice deferred workspace discovery, feature dependency graphs, extension discovery, generic config handlers, agent-assisted operations, provenance, rollback, and plan persistence. Developer-home extension loading has since been implemented (section 10); artifact handlers are now the proposed experiment (section 0.11). This historical list does not reset current implementation status or require feature dependency graphs.

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

Not solved by the Pack slice itself: upstream CLI steps (e.g. `shadcn init`), executable references in presets, version-freshness policy (captured versions are stored verbatim), Rust/Cargo inspection, workspace targets, and replay. Basic replay was subsequently implemented in Slice 2 below.

### Slice 2: Create default web project

Command:

```bash
tamo create hello --preset web
```

Basic replay is implemented (see section 5.1): manifest, seed files, and a planned install, all through the shared plan/execution runtime. Captured dependencies alone cannot regenerate omitted framework scaffolding; capture needed artifacts or, in future scope, author explicit actions. Recipe actions and handler-based customization remain proposed in section 0. Temporary invocation customizations must not mutate the stored preset; exact CLI syntax is unsettled.

Prefer official framework CLIs.

### Slice 3: Mixed monorepo (Deferred Historical Sketch)

This earlier milestone sketch is not the next implementation task. The bounded artifact-handler experiment in section 0.11 comes first; commands below remain illustrative.

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

### 16.6 Custom capability parity test

Can an independently authored handler/planner provide the same capability as a bundled implementation without privileged Core semantics?

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
- How artifact recipes represent optional actions and executable behavior without duplicating native configuration — including the final abstraction, API, and name for that capability (the legacy extension interface is not the answer); basic captured replay already works.
- Exact selector and temporary-customization syntax for create/add; shared structural semantics are recorded in section 0, while older `--with` / `--without` examples are illustrative only.
- Whether `add` should also create new workspace projects or whether project creation needs a separate command.
- How much provenance Tamo should record for applied changes.
- How user-modified values should be handled when a preset later changes.
- How agent-assisted operations are represented in `--json` plans.
- Whether extension versioning belongs in V1.
- How collections identify versions and personal derivations without implicit privileged defaults.
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
