# Tamo engineering guidance

## Context and scope

- Before planning or changing behavior, read the relevant requirements in [SPEC.md](SPEC.md). Consult [PARKING_LOT.md](PARKING_LOT.md) when considering work beyond the active scope; parked ideas are not implementation requirements.
- Use [README.md](README.md) for supported environments and usage, and `package.json` for current versions and commands.
- Follow the user's current request and settled project decisions. Existing implementation is reference material, not authority when it conflicts with these instructions or the spec.
- Complete authorized work through verification. Make routine, reversible implementation decisions independently; ask when a missing decision changes scope or authority. When access is blocked or an action is denied, explain the blocker and request the needed access rather than working around it.

## Stack and Effect

- Use pnpm, TypeScript, Effect v4, and Oxlint.
- Prefer Effect v4's APIs for capabilities Tamo needs. Before implementing infrastructure or adding a dependency, check the installed Effect version and official documentation for an existing solution. This applies across Effect's capabilities, not only filesystem and path operations.
- Supply platform implementations at the application entry point. Use Effect's error handling, resource management, and execution facilities where they replace manual infrastructure.
- Keep pure transformations and data as ordinary TypeScript when that is clearer. Public extension contracts accept ordinary values or promises and do not require extension authors to know Effect; adapt them at the runtime boundary.
- Use direct Node or other APIs when Effect lacks suitable support or they offer a concrete advantage. Explain the choice where it affects maintainers; fewer initial lines alone do not justify rebuilding infrastructure Effect already provides.
- Check APIs against the installed v4 release rather than assuming v3 examples apply. Current Node-based implementation is not precedent for new infrastructure; migrate existing code within the requested task's scope.

## Code style

- `pnpm format` (oxfmt) is authoritative for layout; run it on changed sources before `pnpm check`. It preserves blank lines but never inserts them.
- Group statements into logical paragraphs with single blank lines at phase boundaries, so each function reads in steps a reviewer can scan. This grouping is a judgment call; do not encode it in lint rules, since statement-type rules cannot see meaning and fight intentional density such as guard clauses.

## Architecture and project ownership

- Keep one package with direct modules. Extract shared code when real reuse or a meaningful interface justifies it; introduce additional packages only for a concrete distribution or ownership need.
- Custom implementations inspect, plan, and validate; the runtime alone applies reviewed operations sequentially. Planning is read-only.
- Keep reusable opinions in recipes and native artifacts, semantic knowledge in artifact handlers, and composition/customization mechanics in Core; do not duplicate native config or introduce Core domain taxonomies. See SPEC.md for implemented versus proposed scope. `preset`, `extension`, and `feature` are legacy implementation names for pre-migration code, not target abstractions; new design work uses the recipe/artifact/handler/Core vocabulary.
- Global developer state (presets, extensions) lives under the Tamo home and must be relocatable through `TAMO_HOME`; tests never touch the real home. Projects carry no Tamo metadata and no project-level manifest may become a requirement.
- Inspection stays factual ("what is here"). Judgments about what is reusable belong to pack review or the calling agent, and pack never mutates the source project.
- Ordinary dependencies, reusable files, and official CLI invocations are generic preset primitives; do not add a per-technology extension when a generic primitive suffices.
- Native project files remain authoritative. Preserve unrelated configuration, comments, and scripts; report conflicting required settings before mutation. Recheck reviewed inputs before execution and report partial application accurately.
- Keep plans and results independent of CLI presentation, with JSON output usable by agents.

## Commit messages

- Format every commit message as `<type>: <subject>` on a single line.
- Use only these types: `feat`, `fix`, `docs`, `build`, `chore`.
- Write `<subject>` in lower-case imperative, short and specific, with no trailing period.
- Examples: `docs: add distributable Tamo agent skill`, `fix: scope recipe loading to selected trees`.

## Verification and communication

- Test the changed behavior, including preservation, conflicts, and repeat application when relevant. For code changes, run `pnpm check`; for changes to planning, installation, patching, or validation, also run `pnpm test:integration`.
- After relevant checks pass, broaden testing only when a failure, new change, or unresolved risk justifies it. Documentation-only edits need consistency checks, not the full integration suite.
- Update the owning documentation when behavior or supported scope changes. Report what changed, what was actually verified, and any remaining limitation in concise, direct language.
- Use local Git by default. Fetch, push, or sync remotes only when the user requests it.
