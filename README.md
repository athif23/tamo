# Tamo

Tamo remembers reusable project setup so developers and coding agents do not have to repeatedly reconstruct the same setup decisions.

Tamo helps you set things up, but never takes ownership away from you. It creates ordinary projects, not Tamo projects: native files stay authoritative, and nothing in the result depends on Tamo. Tamo works on its own as a CLI; coding agents can use it as deterministic tooling.

## The problem

Every new project starts with the same repeated setup: package manager choices, TypeScript config, lint rules, Effect conventions, Tailwind/shadcn setup, test tooling, directory layout. Developers either redo it by hand or re-describe it to a coding agent from scratch each time.

Tamo lets those preferences live as reusable Recipes. Define a setup once, then apply it to new or existing projects instead of re-describing it.

## Key properties

- Native project files remain authoritative. Tamo reads and writes the files your tools already understand.
- Projects contain no Tamo metadata. Deleting Tamo changes nothing about them.
- Existing, unrelated project state is preserved when setup is applied.
- Compatible Recipe contributions combine; incompatible intent blocks instead of silently picking a winner.
- Every mutating command supports `--dry-run`, so plans can be reviewed before anything changes.
- Tamo can be used directly from the terminal or driven by a coding agent.

## Installation

The npm package has not been published yet, so there is currently no npm install path. The supported way to run Tamo today is from source:

```sh
pnpm install
node src/cli.ts --help
```

To use the `tamo` executable name used throughout this README, link the package while developing:

```sh
pnpm link --global
tamo --help
```

npm installation instructions will be added here once the package is published.

### Agent skill

The canonical coding-agent skill lives at `skills/tamo/SKILL.md`. It teaches compatible coding agents how to operate the `tamo` CLI. Installing the skill does not install Tamo itself.

Install it with the [`skills`](https://skills.sh/) CLI:

```sh
npx skills add athif23/tamo --skill tamo      # project-level
npx skills add athif23/tamo --skill tamo -g   # global
```

## Quick start

Four commands cover the main workflow. Run `tamo <command> --help` for exact flags.

```sh
# Report what setup a project currently has. Read-only.
tamo inspect --cwd ./my-project

# Capture reusable setup from the current project as a Recipe.
# Review first with --dry-run, then apply with --yes.
tamo pack web --cwd ./my-project \
  --include tsconfig.json \
  --include .oxlintrc.json \
  --dry-run

# Create a new ordinary project from a saved Recipe.
tamo create new-app --recipe web --dry-run

# Apply a Recipe to an existing project.
tamo add lint --cwd ./existing-app --dry-run
```

`--dry-run` plans without changing anything. Without `--yes`, interactive runs ask for confirmation and noninteractive runs exit 2 with `confirmation-required`. Blocked plans and failures exit 1.

## Recipes

A Recipe is reusable setup: ordinary native project files plus a small amount of composition metadata. Recipes live under the Tamo home (default `~/.tamo`, relocatable via `TAMO_HOME`):

```text
~/.tamo/
  recipes/
    web/
      recipe.json
      behavior.mjs       # optional
      artifacts/
        package.json
        tsconfig.json
        ...
```

- **artifacts** are ordinary native project files. They express setup intent in the form the underlying tools already use.
- **recipe.json** holds composition metadata only (which other Recipes this one includes, plus persistent customizations). It never holds native config.
- **behavior.mjs** is optional trusted local code for procedural setup that files alone cannot express, such as running an upstream initializer. Most Recipes do not need it.

Recipes can include other Recipes:

```json
{
  "includes": [
    {"recipe": "typescript"},
    {"recipe": "lint"}
  ]
}
```

`pack` captures reusable setup as it exists in the source project. It does not infer which Recipes the project was built from and does not invent `behavior.mjs`. See `skills/tamo/SKILL.md` (and `SPEC.md` for the full contract) for Recipe authoring details.

## Pack, create, add

**Pack** captures the current project as a Recipe under the Tamo home. It currently supports pnpm projects only. The manifest is captured minus the source project's `name` and `version` (project identity, not reusable setup); other files are captured only when explicitly listed with `--include` (repeatable; a directory expands into its files), and dependencies can be trimmed with `--exclude`. Secrets, private keys, lockfiles, caches, dependency directories, and generated output are never captured. The source project is never modified. Repacking over an existing Recipe requires `--force`.

**Create** applies a saved Recipe to a new project. Its native artifacts land at their original relative paths, the package name follows the new target directory, and a `pnpm install` is planned visibly. Targets that already exist and are non-empty are blocked, never overwritten. If a Recipe's Behavior needs to generate the target first (an upstream initializer), Tamo applies that preparation stage, then replans from fresh state. The result carries no Tamo metadata.

**Add** reconciles a Recipe's setup with an existing project's native state. Compatible state is preserved or combined, identical state is a no-op, missing state is added, and conflicting intent blocks with zero operations. Rerunning a settled plan is idempotent.

## Trust and safety

> **Warning:** `behavior.mjs` is trusted local executable JavaScript. It runs during planning, before confirmation. Review Recipes from untrusted sources before using them. Tamo does not currently sandbox Behavior.

Plan safety:

- Reviewed inputs are fingerprinted and rechecked before execution; changed inputs invalidate the plan.
- Conflicts produce zero operations instead of partial writes.
- External commands (installs, initializers) can still partially change state, and there is no automatic rollback. Execution reports completed and remaining operations on failure, so replan before retrying.

## Current scope and limitations

- Node/pnpm focus. `pack` currently supports pnpm projects only. Workspaces, Rust/Cargo, and other ecosystems are not supported yet.
- Native integration has primarily been exercised on Windows x64. Other platforms have not been verified.
- Behavior is trusted local code with no sandboxing (see above).
- No automatic rollback after partial execution failures.
- The Effect lint setup in `test/fixtures/effect-oxlint` is a currently exercised integration example, not the definition of what Tamo is for.

## Development

Requires Node.js 24.15+ and pnpm.

```sh
pnpm install          # install dependencies
pnpm check            # typecheck, lint, format check, unit tests
pnpm format           # format TypeScript sources
pnpm test:integration # end-to-end CLI run against a temp project (may need registry access)
```

See [SPEC.md](SPEC.md) for the contract and [PARKING_LOT.md](PARKING_LOT.md) for deferred work.

## License

MIT. See [LICENSE](LICENSE).
