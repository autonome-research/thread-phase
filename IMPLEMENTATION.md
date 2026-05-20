# thread-phase 2.x — Implementation Plan

> Status: **v2.4.0 shipped** (post-2.3 review pass). v2.5.0 (features: declarative pipeline format #6 + sub-pipeline composition #8) and v3.0.0 (async JobStore #7) remain. See entries below.



The plan for migrating thread-phase to a monorepo, extending it with extension surfaces (triggers, patterns, adapters, pipelines) and a CLI, and shipping it under the `@autonome-research/` scope.

Track progress by checking items off as they land.

## Resolved design decisions

| Decision | Resolved as |
|---|---|
| Monorepo | npm workspaces, three packages: `@autonome-research/thread-phase`, `-agents`, `-cli`; locked versions |
| Extension scope | Project-local only (`./.thread-phase/<kind>/`); user-global deferred |
| Extension contract | `default export (api) => void` calling `api.register{Trigger,Pattern,Adapter,Pipeline}`; three-tier discovery (loose `.ts` → folder with `index.ts` → folder with `package.json` manifest); per-extension failure isolation |
| CLI scope | `run <name>`, `serve` (bare, no liveness endpoint), `list`; nothing else for v0 |
| Migration | `git filter-repo` to preserve history on both moves |
| `match` | `selector: (ctx) => K \| null`; null = skip silently; emits `phase_branch` event with `taken: key \| 'default' \| 'skip'` |
| `withRetry` | Higher-order wrapper; retries on `ctx.stop` set AND thrown exceptions; no ctx snapshot; optional `resetState` hook |
| `whileCondition` | Predicate-first loop with async predicate support, max-iteration cap, convergence event |
| `Trigger` interface | Generator yielding `{id, occurredAt, input, metadata}`; ship interface + `TimerTrigger` + `runTrigger(trigger, factory, jobRunner)` helper; no HTTP/queue/file-watch impls in core |
| Corpus | `examples/{triggers,patterns,adapters,pipelines}/` — minimal, copyable, working files |
| Vision (README hero) | Substrate framing (see step 1) |

## Vision statement (for the new root README)

> **thread-phase** is a TypeScript substrate for building automation workflows that coordinate AI agents.
>
> A small stable core handles phase ordering, typed shared state, persistence, fanout, and event flow. The parts every project wants to shape — how a pipeline gets triggered, which agent backends are available, how branches and loops are spelled, where state is stored — are extension surfaces with named conventions: drop a file into `.thread-phase/triggers/`, `patterns/`, `adapters/`, or `pipelines/` and the framework picks it up.
>
> Out of the box: cron-driven pipelines, webhook workflows, heterogeneous agent chains, concurrency-capped fanout. Extensible by you — or your own coding agents — without forking the core.

---

## Step 1 → `2.0.0` — Monorepo migration

**Goal:** structural move, naming, vision. No new features.

Work happens in a scratch directory; the existing repos stay untouched until the monorepo is verified.

- [x] Build new monorepo at `/tmp/thread-phase-monorepo/`:
  - [x] Clone `thread-phase`; `git filter-repo --to-subdirectory-filter packages/thread-phase/`
  - [x] Clone `thread-phase-agents`; `git filter-repo --to-subdirectory-filter packages/thread-phase-agents/`
  - [x] Merge the two histories with `--allow-unrelated-histories`
- [x] Root scaffolding:
  - [x] `package.json` with `"workspaces": ["packages/*"]`
  - [x] `tsconfig.base.json` + composite project refs
  - [x] `.npmrc`, `.gitignore` (lint config deferred until needed)
- [x] Per-package rename:
  - [x] `packages/thread-phase/package.json` → `@autonome-research/thread-phase@2.0.0`
  - [x] `packages/thread-phase-agents/package.json` → `@autonome-research/thread-phase-agents@2.0.0`
  - [x] Update internal imports: `from 'thread-phase'` → `from '@autonome-research/thread-phase'`
- [x] Docs:
  - [x] New root `README.md` opening with vision statement
  - [x] Package READMEs stay in their package dirs (npm-display) with rewritten refs
  - [x] `EXTENDING.md` skeleton (filled in with each later step)
  - [x] Root-level `AGENTS.md`, `SKILL.md`, `CONTRIBUTING.md`, `ROADMAP.md`, `LICENSE`
- [x] Verification:
  - [x] `npm install` at root succeeds (workspace symlinks resolved)
  - [x] `npm run build` builds both packages (clean)
  - [x] `npm test` passes (356 tests across 27 files)
  - [x] `npm run typecheck` clean
  - [x] chiya-library compat: pins to commit `88b16b0e` via github URL; that commit remains reachable on the old v1.x tags, so chiya continues to work unchanged. Will need import rewrites when bumped forward.
- [x] Cutover (irreversible step — completed):
  - [x] Move `/home/velvet/thread-phase/` → `/home/velvet/thread-phase-pre-monorepo-backup/`
  - [x] Move `/tmp/thread-phase-monorepo/` → `/home/velvet/thread-phase/`
  - [x] Tombstone README pushed to `Code4me2/thread-phase-agents`; repo archived via `gh repo archive`
  - [x] Force-push monorepo history to `origin/master` (old v1.x tags preserved on remote)
  - [x] Tag `v2.0.0` and push
  - [ ] Publish `@autonome-research/thread-phase@2.0.0` and `@autonome-research/thread-phase-agents@2.0.0` to npm (requires user's npm auth)

**Risk:** `git filter-repo` is destructive on the working clone but the originals are intact. Cutover is the irreversible step — gated on verification.

---

## Step 2 → `2.1.0` — Patterns

`packages/thread-phase/src/patterns/`:

- [x] `while-condition.ts` — `whileCondition(name, { predicate, body, maxIterations })`; predicate is async, runs before each iteration; emits `data` events for `converged` and `max-iterations`
- [x] `match.ts` — `match(name, { selector, cases, default? })`; null selector = skip; emits `data` event `${name}.taken` with `{ taken: key | 'default' | 'skip' }`
- [x] `with-retry.ts` — `withRetry(phase, { maxAttempts, baseDelayMs, isFailure?, onRetry?, resetState? })`; retries on `ctx.stop` OR throw; no ctx snapshot by default
- [x] Tests for each (26 new tests across 3 files; 261 total in core)
- [x] Examples in `examples/patterns/{while-condition,match,with-retry}.ts` — all run end-to-end
- [x] Updated `docs/patterns.md` with selection guidance and per-pattern sections
- [x] Tag `v2.1.0`

---

## Step 3 → `2.2.0` — Trigger interface

`packages/thread-phase/src/triggers/`:

- [x] `types.ts` — `Trigger<TInput>`, `TriggerEvent<TInput>`
- [x] `timer-trigger.ts` — `TimerTrigger({ intervalMs, payload?, fireImmediately?, name? })`
- [x] `run-trigger.ts` — `runTrigger(trigger, factory, options)` free function; blocking-semaphore backpressure (no event drops); optional `jobRunner` + `jobStore` for persistence + status routing to `onError`
- [x] Tests (19 new: TimerTrigger 11, runTrigger 8); 280 total in core
- [x] Examples in `examples/triggers/{timer-basic,timer-with-job-runner,http-adapt,queue-adapt}.ts` — HTTP/queue stay in `examples/`, not core; all four typecheck; three run end-to-end (http-adapt requires a curl)
- [x] Subpath export `@autonome-research/thread-phase/triggers` wired in `package.json`
- [x] Tag `v2.2.0`

---

## Step 4 → `2.3.0` — CLI + auto-loader

New package: `packages/thread-phase-cli/` → `@autonome-research/thread-phase-cli`.

- [x] `ThreadPhaseAPI` registration surface (exported from `@autonome-research/thread-phase-cli`):
  ```ts
  interface ThreadPhaseAPI {
    registerTrigger<TInput>(name: string, trigger: Trigger<TInput>): void;
    registerAdapter<TConfig, TResult>(name: string, adapter: AgentAdapterMeta<TConfig, TResult>): void;
    registerPipeline<TCtx, TInput>(name: string, spec: PipelineSpec<TCtx, TInput>): void;
  }
  ```
  Patterns dropped as a registered surface — they're plain functions the user imports, no registration needed. Three surfaces (triggers, adapters, pipelines) only.
- [x] Loader scans `${cwd}/.thread-phase/{triggers,adapters,pipelines}/`:
  - [x] Tier 1: loose `*.ts`/`*.js`
  - [x] Tier 2: folder with `index.ts`/`index.js`
  - [x] Tier 3: folder with `package.json` carrying `"thread-phase": { "extensions": [...] }`
  - [x] Per-extension errors don't fail the whole load (log + continue); also exposed via `loadExtensions(...).errors`
- [x] `bin/thread-phase` with subcommands:
  - [x] `run <name>` — load → invoke pipeline → exit
  - [x] `serve` — load → instantiate all triggered pipelines → dispatch as they fire (bare, no liveness endpoint); SIGINT/SIGTERM handling
  - [x] `list` — print registered triggers, adapters, pipelines grouped by kind
- [x] Loader uses `tsx`'s ESM `register()` hook (installed lazily on first `.ts` extension) — produces clean dynamic imports and avoids transitive resolution issues
- [x] Tests: fixture projects under `packages/thread-phase-cli/__tests__/fixtures/{basic,folders,manifest,broken}/`; 15 tests covering all tiers + failure isolation + CLI subcommands
- [x] Corpus: `examples/.thread-phase/{triggers,adapters,pipelines}/` with `morning-timer`, `claude-with-flags`, `minimal`, `morning-digest`, `heterogeneous-chain` — verified end-to-end via the bin
- [x] Full `EXTENDING.md` rewritten — TL;DR, contract, three tiers, per-surface templates, CLI commands, kernel boundary, programmatic embedding
- [x] Tag `v2.3.0`

---

## Cross-cutting

| Concern | Approach |
|---|---|
| Test strategy | Each step gated on lint + typecheck + tests passing. CLI gets an end-to-end test using a fixture project. |
| Versioning | Locked across packages. Every tag bumps all three to the same version. |
| Changelog | One `CHANGELOG.md` at root, with sections per package per version. |
| chiya-library compatibility | Verified at step 1 (after rename) and re-verified after step 4 (new public surface). Bump chiya's dep when each minor lands if needed. |
| Skill / AGENTS docs | Updated at each step. SKILL.md trigger phrases get the new extension/CLI keywords by step 4. |

## Deferred past 2.x

- HTTP trigger as a published package (`@autonome-research/thread-phase-triggers-http`) — only if a real user wants one
- User-global extensions (`~/.thread-phase/`)
- `logs <jobId>`, `scaffold`, `doctor`, `test` CLI subcommands
- Async `JobStoreAsync` interface (existing roadmap item)

## Open implementation-detail questions (decide during the work, not now)

- Exact event shapes for `phase_branch`, `convergence`, `attempt`
- Whether the loader uses `tsx` or `jiti`
- Whether `serve` watches the `.thread-phase/` tree for changes and reloads, or requires restart (leaning restart — substrate property, not hot-reload product)
