---
name: tamo
description: Use Tamo to create projects from saved Recipes, apply reusable setup to an existing project, or pack current project setup into a Recipe. Reach for this when the user asks to scaffold, reuse, or remember project setup.
---

# Tamo

Tamo applies reusable project setup. It is available globally as `tamo`
and works in any project directory.

## Mental model

Tamo stores reusable setup as **Recipes** under the Tamo home
(default `~/.tamo`, relocatable via `TAMO_HOME`):

```text
~/.tamo/recipes/<name>/
  recipe.json     # composition metadata only, never native config
  artifacts/**    # ordinary native project files at their project paths
  behavior.mjs    # optional trusted local executable setup
```

- **Artifacts** are ordinary native state (`package.json`, configs, source
  files). Resulting projects stay ordinary and carry no Tamo metadata.
- **`behavior.mjs`** is trusted local code for procedural setup artifacts
  cannot express. It runs during planning, before confirmation.

## Commands

```sh
tamo inspect [--cwd <path>] [--json]
tamo create <dir> --recipe <name> [--cwd <path>] [--dry-run] [--json] [--yes]
tamo add <recipe> [--cwd <path>] [--dry-run] [--json] [--yes]
tamo pack <recipe-name> [--cwd <path>] [--include <path>]... [--exclude <pkg>]... [--force] [--dry-run] [--json] [--yes]
```

- `inspect` reports the factual setup of a project. Read-only.
- `create` applies a Recipe to a new project. The package name follows
  the target directory. Non-empty targets are blocked, never overwritten.
- `add` applies a Recipe to the existing project at `--cwd` (default `.`).
- `pack` captures the current project as a Recipe. The manifest is always
  captured (minus the source project's `name` and `version`, which are
  project identity rather than reusable setup); other files only via
  `--include` (a file or a directory, which expands); dependencies can be
  trimmed with `--exclude`. Secrets, keys, lockfiles, caches, dependency
  directories, and generated output are never captured. Repacking over an
  existing Recipe requires `--force`. The source project is never modified.

Flags: `--cwd` selects the target project; `--dry-run` plans without
changing anything; `--json` prints machine-readable output;
`--yes` applies noninteractively; `-h`/`--help` prints the command summary.

Exit codes: `0` plan shown / applied / nothing to do; `2` Tamo needs
confirmation (pass `--yes`); `1` blocked on a conflict or failed.

## Dry-run first

Prefer `--dry-run` before applying meaningful setup changes. A dry-run
shows native file changes, commands Tamo would run, conflicts, and whether
the plan carries `requiresReplan`.

## Staged plans

Some Recipes run an initializer or preparation command first. Tamo then
works in stages: preparation → fresh inspection/replan → artifact changes
→ finalization → verification. A first dry-run with `requiresReplan: true`
honestly shows only the currently knowable preparation stage. Let Tamo
execute it and replan; missing downstream writes at that point are
expected, not a bug. Never flatten or hand-reproduce the stages.

## Existing state

Work from current native state, never from provenance. Never check whether
a project or Recipe "already contains" something, and never delete
overlapping setup just to make a Recipe apply: compatible state is
preserved or combined, identical state is a no-op, missing state is added,
and incompatible intent surfaces as a conflict.

## Conflicts

A blocked plan is a valid safe result. When Tamo reports one, do not
silently overwrite files, edit the target just to force the command
through, or touch Tamo source. Report the conflicting intent/state to the
user when judgment is required.

## Pack rules

`pack` captures reusable native state as it exists. Source package `name`
and `version` are not captured as reusable identity. Pack does not infer
Recipe ancestry, does not record which Recipes the project "uses", does
not invent `behavior.mjs`, and needs no provenance metadata. Do not
decompose or refactor the packed result.

## Authoring a Recipe

An agent can author a minimal durable Recipe from this section alone.
Public layout (`recipe.json` holds composition metadata only, never native
config):

```text
~/.tamo/recipes/<name>/
  recipe.json     # includes + persistent customizations only
  artifacts/**    # ordinary native project files at their project paths
  behavior.mjs    # optional trusted local executable setup
```

Composition:

```json
{
  "includes": [
    {"recipe": "effect"},
    {"recipe": "vitest"}
  ]
}
```

A persistent per-instance omission lives in the same file as an omit
record (`instance` is the include chain relative to this recipe;
selectors today are `dependencies`/`devDependencies` in `package.json`
and `rules` in Oxlint configs):

```json
{
  "customizations": [
    {"op": "omit", "instance": ["effect"], "artifact": "package.json",
     "selector": "dependencies", "entry": "stripe"}
  ]
}
```

### behavior.mjs

Minimal valid plain-JS module (only `prepare`/`finalize`/`verify` keys are
allowed; at least one hook must be present):

```js
export default {
  prepare,   // optional: upstream commands whose output planning needs first
  finalize,  // optional: commands that run after artifact writes are planned
  verify,    // optional: check the applied result
};
```

`prepare`/`finalize` receive `{ cwd, instance, artifacts, read, track }`:
`cwd` is the target directory, `instance` the recipe's include chain,
`artifacts` this instance's resolved contributions, `read(path)` a
target-relative tracked read, and `track(path, contents)` explicit tracking
for observations made outside `read`. `verify` receives only
`{ cwd, instance, artifacts }` — it has no `read`/`track`.

Result contract (anything else fails loudly at the Behavior boundary):

- `prepare`/`finalize`: `undefined` (no procedural work), or
  `{ conflicts?: string[], evidence?: string[], operations?: CommandOperation[] }`
  with only those keys; omitted fields default to empty.
- `verify`: `undefined` or `[]` means success, otherwise `string[]` failures.

A command operation uses exactly these fields:

```js
{ kind: "command", executable: "pnpm", args: ["install"], cwd, purpose: "Install dependencies" }
```

`prepare`/`finalize` may only contribute command operations — they cannot
directly write artifacts (a write operation is rejected). Native desired
state belongs in `artifacts/**`. Gate Behavior on actual project state
through the tracked reads so settled reruns plan nothing.

During `create`, the target may not exist when `prepare` runs. A
scaffolding initializer must therefore use an existing command cwd (often
the parent workspace) and pass the target/name to the upstream CLI as
needed.

## Trust

`behavior.mjs` executes during planning, before confirmation. Never create
or execute behavior modules copied from untrusted remote sources without
explicit user intent.

## When something looks wrong

Do not patch Tamo source, edit this skill, weaken Recipe checks, or repair
the target by hand and claim Tamo worked. Capture the exact command, cwd,
relevant Tamo output, whether it was a dry-run or an apply, whether any
operations completed, relevant before/after state, and whether Tamo blocked
safely or partially applied — then report it.

## Unsure about syntax

```sh
tamo --help
tamo <command> --help
```

`tamo --help` prints the command overview; `tamo <command> --help` prints
that command's usage and supported flags. Never guess flags.
