# tamo

`tamo` remembers reusable project setup so you do not have to rebuild or re-explain the same setup every time.

It helps set up ordinary projects without taking ownership of them. Native project files stay authoritative, and the project does not depend on `tamo` afterward.

## Install

### CLI

```sh
npm install -g @atindo23/tamo
tamo --help
```

### Agent skill

The coding-agent skill teaches compatible agents how to discover, save, and reuse Recipes with `tamo`.

```sh
npx skills add athif23/tamo --skill tamo      # project-level
npx skills add athif23/tamo --skill tamo -g   # global
```

Installing the skill does not install the CLI itself.

## Quick start

### Create from a Recipe

```sh
tamo create my-app --recipe web --dry-run
```

Review the plan, then apply it:

```sh
tamo create my-app --recipe web --yes
```

### Save reusable setup

```sh
tamo pack web --cwd ./my-project \
  --include tsconfig.json \
  --include src/styles.css \
  --dry-run
```

Then save it:

```sh
tamo pack web --cwd ./my-project \
  --include tsconfig.json \
  --include src/styles.css \
  --yes
```

### Add setup to an existing project

```sh
tamo add lint --cwd ./my-project --dry-run
```

### Inspect a project

```sh
tamo inspect --cwd ./my-project
```

Every mutating command supports `--dry-run`, so you can review what `tamo` plans to do before anything changes.

### With an agent

Once the skill is installed, you can describe what you want without naming a Recipe first:

> create a web app using TanStack Start, TypeScript, Tailwind, and shadcn

The agent can discover matching saved Recipes before rebuilding the same setup.

When you want to keep a setup for later:

> i like this setup, save it with tamo

The agent can curate the reusable parts into a Recipe while leaving the source project untouched.

## Why tamo

Project setup is repetitive. The same framework choices, TypeScript settings, lint rules, UI setup, test tooling, and directory conventions often get rebuilt or re-explained from project to project.

`tamo` lets those decisions live as reusable Recipes.

The key idea is:

> Reusable setup without tool ownership.

A Recipe can be used to create a new project or reconciled into an existing one. The result stays an ordinary project with ordinary native files.

### Templates

Templates and starter repos are useful when you want to copy a known starting point.

```text
template
  ↓ copy / render
new project
```

A Recipe is different. It represents reusable setup that can be planned against the project that already exists.

```text
Recipe
  ↓ plan + reconcile
new or existing project
```

Recipes can also compose. Where `tamo` understands the artifact type, compatible contributions combine and incompatible intent blocks instead of silently picking a winner.

A template is still the simpler choice when a fixed copied starting point is exactly what you want.

### Projen

Projen-style generators keep a generator definition as the source of truth and generate project files from it.

```text
generator definition
        ↓
generated project files
```

`tamo` deliberately keeps the native project files as the source of truth.

```text
native project files
        ↕
   reusable Recipe
        ↓
native project files
```

`tamo` applies setup when asked, then gets out of the way. It does not continuously own or regenerate the project afterward.

Use a generator when you want centralized ownership of project configuration. Use `tamo` when you want reusable setup without handing ownership of the project to the setup tool.

Coding agents are one useful way to drive `tamo`, but they are not required. The CLI works on its own.

## Recipes

A Recipe is reusable setup expressed through ordinary native project files plus a small amount of composition metadata.

Recipes live under the `tamo` home directory, which defaults to `~/.tamo` and can be changed with `TAMO_HOME`.

```text
~/.tamo/
  recipes/
    web/
      recipe.json
      behavior.mjs        # optional default behavior entrypoint
      artifacts/
        package.json
        tsconfig.json
        ...
```

### Artifacts

`artifacts/` contains ordinary native project files. These are the files the underlying tools already understand, such as `package.json`, `tsconfig.json`, `components.json`, or tool-specific config.

The project itself does not get a project-level `tamo.json`.

### recipe.json

`recipe.json` contains Recipe composition metadata, such as included Recipes, persistent customizations, and an optional Behavior entrypoint.

Example:

```json
{
  "includes": [
    { "recipe": "typescript" },
    { "recipe": "lint" }
  ]
}
```

A Recipe may also choose a custom relative `.mjs` Behavior entrypoint:

```json
{
  "behavior": "scripts/setup.mjs"
}
```

If no explicit path is configured, `behavior.mjs` is the zero-config default.

### Behavior

Behavior is optional trusted local JavaScript for procedural setup that native files alone cannot express, such as running an upstream initializer.

Most Recipes do not need it.

Behavior can participate around artifact application through three hooks:

```text
prepare
  ↓
apply artifacts
  ↓
finalize
  ↓
verify
```

Behavior is trusted executable code and is not currently sandboxed.

## Commands

Run `tamo <command> --help` for exact flags.

### pack

`pack` saves selected setup from an existing Node project as a Recipe.

```sh
tamo pack web --cwd ./my-project \
  --include tsconfig.json \
  --include src \
  --dry-run
```

`pack` is package-manager agnostic for Node projects with a valid `package.json`.

The source project's `name` and `version` are not treated as reusable setup. `packageManager` is preserved when present and is never invented.

Secrets, private keys, lockfiles, caches, dependency directories, and generated output are not captured.

The source project is never modified.

Repacking over an existing Recipe requires `--force`.

### create

`create` applies a Recipe to a new project.

```sh
tamo create my-app --recipe web --dry-run
```

Native artifacts are written to their normal relative paths. The new package name follows the target directory, and dependency installation is planned visibly.

Targets that already exist and are non-empty are blocked instead of overwritten.

The resulting project contains no `tamo` metadata.

### add

`add` reconciles a Recipe with an existing project.

```sh
tamo add lint --cwd ./my-project --dry-run
```

Compatible state is preserved or combined, identical state becomes a no-op, missing state is added, and conflicting intent blocks instead of silently overwriting existing setup.

Rerunning a settled Recipe is idempotent.

### inspect

`inspect` reports setup detected in an existing project and does not modify it.

```sh
tamo inspect --cwd ./my-project
```

For machine-readable output:

```sh
tamo inspect --cwd ./my-project --json
```

## Safety

`behavior.mjs` and custom Behavior entrypoints are trusted local executable JavaScript. They run during planning, before confirmation.

Review untrusted Recipes before using them.

Other safety properties:

- reviewed inputs are fingerprinted and rechecked before execution
- changed inputs invalidate the reviewed plan
- conflicts produce zero operations instead of partial writes
- mutating commands support `--dry-run`
- external commands can still partially change state
- there is currently no automatic rollback

If execution fails after some operations have completed, `tamo` reports completed and remaining work so the project can be replanned before retrying.

## Limitations

- `tamo` currently focuses on Node projects.
- `tamo pack` can save setup from Node projects using any package manager. New projects created with `tamo create` currently use pnpm for dependency installation.
- Workspaces and non-Node ecosystems are not supported yet.
- Native integration has primarily been exercised on Windows x64.
- Behavior is trusted local code and is not sandboxed.
- There is no automatic rollback after partial execution failures.

## Development

Requires Node.js 24.15+ and pnpm.

```sh
pnpm install
pnpm check
pnpm format
pnpm test:integration
```

To run the CLI directly from source:

```sh
pnpm install
node src/cli.ts --help
```

See [SPEC.md](SPEC.md) for the full contract and [PARKING_LOT.md](PARKING_LOT.md) for deferred work.

## License

MIT. See [LICENSE](LICENSE).
