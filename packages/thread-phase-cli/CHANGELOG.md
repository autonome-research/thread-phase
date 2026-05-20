# Changelog

All notable changes to this package are documented here.

## [Unreleased]

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
