# thread-phase 2.x — Implementation Plan

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

- [ ] Build new monorepo at `/tmp/thread-phase-monorepo/`:
  - [ ] Clone `thread-phase`; `git filter-repo --to-subdirectory-filter packages/thread-phase/`
  - [ ] Clone `thread-phase-agents`; `git filter-repo --to-subdirectory-filter packages/thread-phase-agents/`
  - [ ] Merge the two histories with `--allow-unrelated-histories`
- [ ] Root scaffolding:
  - [ ] `package.json` with `"workspaces": ["packages/*"]`
  - [ ] `tsconfig.base.json`
  - [ ] `.npmrc`, `biome.json` or eslint, husky if desired
- [ ] Per-package rename:
  - [ ] `packages/thread-phase/package.json` → `@autonome-research/thread-phase`
  - [ ] `packages/thread-phase-agents/package.json` → `@autonome-research/thread-phase-agents`
  - [ ] Update internal imports: `from 'thread-phase'` → `from '@autonome-research/thread-phase'`
- [ ] Docs:
  - [ ] New root `README.md` opening with vision statement
  - [ ] Move existing READMEs into their package dirs
  - [ ] `EXTENDING.md` skeleton (filled in with each later step)
  - [ ] Update `AGENTS.md` + `SKILL.md` for the new structure
- [ ] Verification:
  - [ ] `npm install` at root succeeds
  - [ ] `npm run build` builds both packages
  - [ ] `npm test` passes (all existing tests intact)
  - [ ] Verify `chiya-library` builds against `@autonome-research/thread-phase@2.0.0-beta.1` (local verdaccio or `npm pack` + install tarball)
- [ ] Cutover (only after verification passes — this step is irreversible):
  - [ ] Move `/home/velvet/thread-phase/` → `/home/velvet/thread-phase-pre-monorepo-backup/`
  - [ ] Move `/tmp/thread-phase-monorepo/` → `/home/velvet/thread-phase/`
  - [ ] Archive `Code4me2/thread-phase-agents` GitHub repo with a README tombstone pointing at the new location
  - [ ] Push to the GitHub remote
  - [ ] Tag `v2.0.0`, publish both packages

**Risk:** `git filter-repo` is destructive on the working clone but the originals are intact. Cutover is the irreversible step — gated on verification.

---

## Step 2 → `2.1.0` — Patterns

`packages/thread-phase/src/patterns/`:

- [ ] `while-condition.ts` — `whileCondition(name, { predicate, body, maxIterations })`; predicate is async, runs before each iteration; emits `convergence` event on exit
- [ ] `match.ts` — `match(name, { selector, cases, default? })`; null selector = skip; emits `phase_branch` with `taken: key | 'default' | 'skip'`
- [ ] `with-retry.ts` — `withRetry(phase, { maxAttempts, baseDelayMs, isFailure?, onRetry?, resetState? })`; retries on `ctx.stop` OR throw; no ctx snapshot by default
- [ ] Tests for each (mirror existing patterns' test files)
- [ ] Examples in `examples/patterns/{while-condition,match,with-retry}.ts`
- [ ] Update `docs/patterns.md` with selection guidance
- [ ] Tag `v2.1.0`

---

## Step 3 → `2.2.0` — Trigger interface

`packages/thread-phase/src/triggers/`:

- [ ] `types.ts` — `Trigger<TInput>`, `TriggerEvent<TInput>`
- [ ] `timer-trigger.ts` — `TimerTrigger({ intervalMs })`
- [ ] `run-trigger.ts` — `runTrigger(trigger, factory, { jobRunner, maxConcurrency })` free function
- [ ] Tests
- [ ] Examples in `examples/triggers/{timer-basic,timer-with-cron,http-adapt,queue-adapt}.ts` — HTTP/queue stay in `examples/`, not core; they demonstrate the adapter pattern (turn external event → `TriggerEvent`)
- [ ] Tag `v2.2.0`

---

## Step 4 → `2.3.0` — CLI + auto-loader

New package: `packages/thread-phase-cli/` → `@autonome-research/thread-phase-cli`.

- [ ] `ThreadPhaseAPI` registration surface (exported from core):
  ```ts
  interface ThreadPhaseAPI {
    registerTrigger(name: string, trigger: Trigger): void;
    registerPattern(name: string, factory: PatternFactory): void;
    registerAdapter(name: string, adapter: AgentAdapter): void;
    registerPipeline(name: string, pipeline: PipelineSpec): void;
  }
  ```
- [ ] Loader scans `${cwd}/.thread-phase/{triggers,patterns,adapters,pipelines}/`:
  - [ ] Tier 1: loose `*.ts`/`*.js`
  - [ ] Tier 2: folder with `index.ts`/`index.js`
  - [ ] Tier 3: folder with `package.json` carrying `"thread-phase": { "extensions": [...] }`
  - [ ] Per-extension errors don't fail the whole load (log + continue)
- [ ] `bin/thread-phase` with subcommands:
  - [ ] `run <name>` — load → invoke pipeline → exit
  - [ ] `serve` — load → instantiate all triggers → dispatch as they fire (bare, no liveness endpoint)
  - [ ] `list` — print registered extensions, grouped by kind
- [ ] Loader uses `tsx` or `jiti` for runtime TypeScript (decide during impl; jiti is lighter, tsx matches existing examples)
- [ ] Tests: fixture project under `packages/thread-phase-cli/test/fixtures/` with a sample `.thread-phase/` tree
- [ ] Corpus: populate `examples/pipelines/{minimal,bounded-fanout,heterogeneous-chain,cron-digest}.ts`
- [ ] Full `EXTENDING.md`: "to add an X, do Y" map covering every extension surface
- [ ] Tag `v2.3.0`

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
