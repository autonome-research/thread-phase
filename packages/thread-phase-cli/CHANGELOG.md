# Changelog

All notable changes to this package are documented here.

## [Unreleased]

## [6.1.0] — 2026-07-22

- Locked-version release consuming the additive core v6.1 lifecycle APIs. CLI behavior is unchanged.
- Aligned the CLI Node requirement with the v6 core `node:sqlite` runtime: Node.js 22.5 or newer.

## [6.0.0] — 2026-07-17

- Locked-version release consuming the core v6 `node:sqlite` backend and fanout/helper updates.

## [3.2.2] — 2026-05-21

### Fixed

- **Dangling `EXTENDING.md` reference in scaffolded `lib/README.md`.** The template said "See EXTENDING.md for the full convention" but scaffolded projects don't ship `EXTENDING.md` — it lives in the framework's repo. Changed to an absolute GitHub URL so the link works from any scaffolded project.

## [3.2.1] — 2026-05-21

Follow-up to v3.2.0 driven by post-release agent feedback.

### Changed

- **`thread-phase init` now scaffolds both core + CLI as explicit deps.** The generated `package.json` lists `@autonome-research/thread-phase` AND `@autonome-research/thread-phase-cli` directly. Previously only the CLI was declared; core came in transitively, which made `npm ls` misleading and risked surprises if a teammate edited the package.json without the CLI installed.
- **`thread-phase init` drops a `lib/README.md`** explaining the convention so the empty `lib/` directory isn't mysterious. Two-paragraph note with a concrete example layout.

### Added

- **Empty-but-exists `.thread-phase/` hint.** When `.thread-phase/` is present but no extensions are registered, `thread-phase list` now prints a one-line "drop a file in pipelines/" hint with a working example. Previously this case showed bare `(0)` rows with no guidance — friction-report item from a coding agent.

## [3.2.0] — 2026-05-21

Adoption-friendly improvements driven by the pi-agent friction report on v3.1.0. All additive; no breaking changes.

### Added

- **`thread-phase init [name]`** — scaffolds a new project: `.thread-phase/{triggers,adapters,pipelines,lib}/`, a sample `pipelines/hello.ts` using `oneShot`, and a `package.json` if absent. With `[name]`: `mkdir name/` then scaffold inside (errors if the dir already exists). Without: scaffold in cwd. Refuses if `.thread-phase/` already exists at the target. Prints a "next steps" block with `npm install` + `thread-phase run hello`. Eliminates the biggest first-use friction.
- **Walk-up `.thread-phase/` discovery** — the loader now searches `cwd` and every ancestor for `.thread-phase/`, like git's `.git/` lookup. Running `thread-phase list` from `~/proj/src/handlers` will find `~/proj/.thread-phase/`. When the directory is found above `cwd`, the CLI prints `Loading extensions from <abspath>/.thread-phase` so the source of the registry is unambiguous.
- **Load summary** — after extension loading, the CLI prints `Loaded N extensions` (and, on partial failure, `Loaded N extensions; M failed:` plus indented failure paths). Surfaces load failures that previously could be missed in a busy terminal.
- **`--strict` flag** — top-level `thread-phase --strict <subcommand>` exits non-zero on any load failure. Use in CI / CD to gate on registry health.

### Changed

- **CLI `bin` manifest path normalized** — `"./dist/bin.js"` → `"dist/bin.js"`. Silences a long-standing npm publish warning ("script name dist/bin.js was invalid and removed") that was cosmetic but appeared on every CLI publish. Behavior unchanged — `npm install -g` still wires `thread-phase` to the same script.
- **`LoadResult` shape** — added `extensionRoot: string | null` (where `.thread-phase/` was found, or `null` if no ancestor has one). Surfaced through the loader API for programmatic consumers.

### Tests

41 tests total (was 32). 9 new: 5 for `init` (scaffold paths, existing-dir refusal, subdir, already-initialized refusal, existing-package.json preserved), 1 for walk-up discovery, 1 for load summary, 2 for `--strict` (success exit 0, failure exit 1).

## [3.1.0] — 2026-05-21

Locked-version release in step with `@autonome-research/thread-phase-agents@3.1.0` (re-exported consumer + chain-builder surface) and `@autonome-research/thread-phase@3.1.0` (new pipeline/inject/loops doc sections). No CLI changes.

## [3.0.3] — 2026-05-21

Locked-version release in step with `@autonome-research/thread-phase@3.0.3` (agent-facing docs updated). No CLI changes.

## [3.0.2] — 2026-05-20

### Added

- **`thread-phase --version` / `-v`** at top level — prints `thread-phase <version>` (read from `package.json`) and exits 0. Previously these flags were treated as unknown subcommands.
- **Empty-`list` hint** — when `${cwd}/.thread-phase/` doesn't exist, `list` now prints a four-line "how to get started" snippet (mkdir + a sample `oneShot` pipeline + `thread-phase run`) plus a link to `EXTENDING.md`, instead of printing three empty registries.

### Changed

- Help text reorganized to include `--version`, `--help`, and the optional flags for each subcommand.

## [3.0.1] — 2026-05-20

Locked-version release in step with `@autonome-research/thread-phase-agents@3.0.1` (heavy agent SDKs moved to optional peer deps). No CLI changes — installing `@autonome-research/thread-phase-cli` still pulls in core + agents + tsx, but the agents package no longer drags in `@anthropic-ai/sdk`, `openai@6`, or `@mariozechner/pi-coding-agent` transitively. Install those separately for the adapters you use.

## [3.0.0] — 2026-05-20

Packaging restructure: `@autonome-research/thread-phase-cli` now depends on `@autonome-research/thread-phase` AND `@autonome-research/thread-phase-agents` as regular (non-peer) deps. `npm install @autonome-research/thread-phase-cli` now gets the full runtime. tsx remains a regular runtime dep (the CLI uses it for loading user extensions).

## [2.5.0] — 2026-05-20

Sub-pipeline composition surfaces through the registry.

### Added

- **`ThreadPhaseAPI.getPipeline(name)` / `getAdapter(name)` / `getTrigger(name)`** — lookup methods on the registration API so extensions can reference each other by name (typically inside `subPipeline`'s lazy resolver). Late-bound: registration order between extensions doesn't matter; lookup happens at dispatch time, not load time. `Registry` already implements them — this is purely an interface widening.

### Notes

- Working example at `examples/.thread-phase/pipelines/composed.ts` — invokes `minimal` as a sub-pipeline via lazy registry lookup.
- No CLI command changes.

## [2.4.0] — 2026-05-20

CLI ergonomics + shared-code convention. Reads the post-2.3 review and lands the items that mapped to this package (#2, #3, #5, #10, #11).

### Added

- **`list --verbose`** — `thread-phase list -v` prints each registry entry's structural details indented underneath it, so an agent can decide whether to invoke a pipeline without reading source. Triggers report their class name; adapters report id, source, and capabilities; pipelines report source, description, trigger binding, whether `phases`/`ctx` are literal or factory, and `defaultInput` (JSON-stringified).
- **`run <name> --input <value>`** — override `defaultInput` on a one-shot run. Three forms: `--input '{"json":"literal"}'` (inline JSON), `--input @path/to/file.json` (file), `--input -` (stdin). Invalid JSON or unreadable files exit 1 with a `invalid --input: …` stderr message.
- **`serve --health-port <n>`** — opt-in tiny `node:http` health endpoint. Returns `200 {"status":"ok"}` while the serve loop is running, `503 {"status":"shutting_down"}` after stop() begins but before all pipelines drain, and stops listening cleanly when serve exits.
- **`RunCliOptions.stdin`** and **`RunCliOptions.abortSignal`** — new optional fields exposed for embedders/tests. `stdin` backs `--input -`; `abortSignal` initiates the same shutdown path as SIGINT/SIGTERM.

### Changed

- **Loader internals refactored** (#5). The ESM/CJS-interop unwrap moved out of `loadOne` into a pure `normalizeModuleShape<T>(mod)` plus a thin `loadModule<T>(url)` wrapper. Both are exported. `loadOne` now reads cleanly: `await loadModule(url)`, then check for a function default. The pure normalizer is unit-tested directly (vitest's resolver always delivers ESM shape, so this is the only honest unit boundary).

### Documentation

- **Shared-code convention** (#10). Documented `.thread-phase/lib/` as the conventional home for user-side code shared between extensions (custom patterns, helpers, shared types). Files under `lib/` are **not** auto-loaded — the loader still scans only `triggers/`, `adapters/`, and `pipelines/` — they're imported by registered extensions via relative paths. New section in `EXTENDING.md` and a working example at `examples/.thread-phase/lib/poll-until.ts`, consumed by `examples/.thread-phase/pipelines/poll-job.ts`.

### Tests

- 29 total (was 15). 10 new CLI tests (verbose list, three input forms + error path, three health-port states), 3 new loader tests (normalizer ESM passthrough, CJS unwrap, no-default), 1 fixture cleanup (unused `cjs-default.cjs` removed).

## [2.3.0] — 2026-05-20

Initial release of the CLI and auto-loader.

### Added

- **`thread-phase` bin** with three subcommands:
  - `run <pipeline-name>` — invoke a registered pipeline once and exit
  - `serve` — start all triggered pipelines (SIGINT/SIGTERM to stop, backpressure via blocking semaphore)
  - `list` — print everything registered, grouped by kind
- **Auto-loader** scanning `${cwd}/.thread-phase/{triggers,adapters,pipelines}/` with three discovery tiers:
  - Tier 1: loose `.ts`/`.js` files
  - Tier 2: folder with `index.ts`/`index.js`
  - Tier 3: folder with `package.json` carrying `"thread-phase": { "extensions": [...] }`
- **`ThreadPhaseAPI`** registration surface: `registerTrigger`, `registerAdapter`, `registerPipeline`. Each registration is attributed to its source path for error messages and `list` output.
- **Per-extension failure isolation** — one bad file doesn't fail the rest of the load.
- **`PipelineSpec`** shape: `phases` and `ctx` can be literal or factory; optional `trigger`, `defaultInput`, `description`.
- **Programmatic API**: `Registry`, `loadExtensions`, `runCli` exported for embedding the loader inside other runtimes.

### Implementation notes

- TypeScript extension files are loaded via tsx's `register()` ESM hook (installed lazily on first `.ts` extension), then plain dynamic `import()`. Handles tsx's CJS-interop default-wrapping transparently.
- Backed by a `Registry` keyed by name with collision detection. Duplicate registrations throw with both the new and prior source paths.

### Tests

- 15 tests: 8 loader (discovery tiers, failure isolation, strict mode, attribution, collisions), 7 CLI (help, list, run happy path + errors, serve with/without triggered pipelines).
