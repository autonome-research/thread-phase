# thread-phase

> Extensible automation building blocks for agent authors.

A small TypeScript runtime for executing bounded, deterministic, composable sequences of agent and code phases — cron jobs, webhooks, one-shots, agent chains, and reusable workflow extensions. Drop a file into `.thread-phase/`, the framework picks it up.

“Deterministic” describes workflow structure: phase order, concurrency, branching, retries, cancellation, checkpoints, and terminal states are encoded. Agent output inside a phase remains probabilistic. thread-phase can own a standalone job or run inside a node of Temporal/LangGraph/Inngest; it is not a distributed DAG scheduler, product UI, or JavaScript sandbox.

## Install

```sh
npm install @autonome-research/thread-phase-cli
```

That's everything: library + adapter protocol + `thread-phase` CLI. The heavy agent SDKs (`@anthropic-ai/sdk`, `openai`, `@earendil-works/pi-coding-agent`) are optional peer deps — install only the ones whose adapter you use.

## Hello world

```ts
// .thread-phase/pipelines/hello.ts
import { oneShot } from '@autonome-research/thread-phase';

export default oneShot(async () => {
  return { greeting: 'hello from thread-phase' };
});
```

```sh
thread-phase run hello
```

`schedule({ intervalMs })`, `schedule({ cron })`, `hook({ path })` work the same way for cron jobs and webhooks. See [`EXTENDING.md`](./EXTENDING.md).

## Packages

| Package | Purpose |
|---|---|
| [`@autonome-research/thread-phase`](./packages/thread-phase) | Library: `Phase`, `runPipeline`, `Trigger`, `JobRunner`, patterns, helpers (`oneShot` / `schedule` / `hook`). |
| [`@autonome-research/thread-phase-agents`](./packages/thread-phase-agents) | Adapter implementations for claude-code, codex, hermes, openclaw, pi, Anthropic, ACP chassis. |
| [`@autonome-research/thread-phase-cli`](./packages/thread-phase-cli) | `thread-phase` bin + auto-loader. Depends on the other two — installing this gets the whole runtime. |

Locked versions across all three.

## Docs

- [`AGENTS.md`](./AGENTS.md) — full guide for LLM agents generating thread-phase code.
- [`EXTENDING.md`](./EXTENDING.md) — extension contract (triggers, adapters, pipelines), three discovery tiers, and the `thread-phase.extensions` manifest format for extensions that need their own npm deps.
- [`MIGRATING.md`](./MIGRATING.md) — version-by-version upgrade notes.
- [`ROADMAP.md`](./ROADMAP.md) — project direction and release priorities.
- [`docs/developer-experience-roadmap.md`](./docs/developer-experience-roadmap.md) — known lifecycle/DX shortcomings, adoption priorities, and acceptance criteria.
- [`docs/unreleased-api-inventory.md`](./docs/unreleased-api-inventory.md) — stable API additions since published v5.0.0 and release-line evidence.
- [`packages/thread-phase/docs/`](./packages/thread-phase/docs) — patterns, recipes, cancellation.

## License

MIT.
