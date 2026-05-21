# thread-phase

> Extensible automation building blocks for agent authors.

A small TypeScript runtime for composing AI-agent calls into deterministic pipelines — cron jobs, webhooks, one-shots, agent chains. Drop a file into `.thread-phase/`, the framework picks it up.

## Install

```sh
npm install @autonome-research/thread-phase-cli
```

That's everything: library + adapter protocol + `thread-phase` CLI. The heavy agent SDKs (`@anthropic-ai/sdk`, `openai`, `@mariozechner/pi-coding-agent`) are optional peer deps — install only the ones whose adapter you use.

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
- [`EXTENDING.md`](./EXTENDING.md) — extension contract (triggers, adapters, pipelines).
- [`MIGRATING.md`](./MIGRATING.md) — v2 → v3 upgrade notes.
- [`packages/thread-phase/docs/`](./packages/thread-phase/docs) — patterns, recipes, cancellation.

## License

MIT.
