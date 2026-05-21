# Changelog

All notable changes to this package are documented here.

## [Unreleased]

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
