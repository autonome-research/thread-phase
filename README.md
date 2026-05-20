# thread-phase

> A TypeScript substrate for building automation workflows that coordinate AI agents.

A small stable core handles phase ordering, typed shared state, persistence, fanout, and event flow. The parts every project wants to shape — how a pipeline gets triggered, which agent backends are available, how branches and loops are spelled, where state is stored — are extension surfaces with named conventions: drop a file into `.thread-phase/triggers/`, `patterns/`, `adapters/`, or `pipelines/` and the framework picks it up.

Out of the box: cron-driven pipelines, webhook workflows, heterogeneous agent chains, concurrency-capped fanout. Extensible by you — or your own coding agents — without forking the core.

## Packages

This is a monorepo. The published packages live in `packages/`:

| Package | Purpose |
|---|---|
| [`@autonome-research/thread-phase`](./packages/thread-phase) | The substrate. `Phase`, `runPipeline`, `AgentAdapter`, `Thread`, `JobRunner`, built-in patterns, the in-tree `runAgentWithTools` tool-use loop. |
| [`@autonome-research/thread-phase-agents`](./packages/thread-phase-agents) | Agent adapters. Uniform `AgentAdapter` protocol wrapping claude-code, codex, codex-cli, hermes, openclaw, the Anthropic SDK, pi, and an ACP chassis. |

All packages release in lockstep at the same version.

## Where to start

- **Building a pipeline?** See [`packages/thread-phase/README.md`](./packages/thread-phase/README.md) for the quickstart and core primitives.
- **Wrapping an external agent?** See [`packages/thread-phase-agents/README.md`](./packages/thread-phase-agents/README.md) for the adapter protocol and the existing wrappers.
- **Generating thread-phase code with an LLM agent?** See [`AGENTS.md`](./AGENTS.md) — a self-contained reference with the mental model, copy-paste templates, and anti-patterns. Claude Code users can also install [`SKILL.md`](./SKILL.md) into `~/.claude/skills/thread-phase/`.
- **Extending the framework?** See [`EXTENDING.md`](./EXTENDING.md) — the map of extension surfaces (triggers, patterns, adapters, pipelines) with conventions for each.

## What thread-phase is for

Two shapes:

1. **Agent-authored automations.** A coding agent (Claude Code, Codex, Hermes) writes a pipeline once and drops it in cron or a systemd timer. The deterministic parts — phase ordering, fanout, ctx flow, post-condition checks — are encoded in TypeScript. The non-deterministic parts happen inside phases via `AgentAdapter` calls. The cron line is a plain `npx thread-phase run <name>`; no prompt at run time.
2. **Mini-workflows inside DAG frameworks.** Temporal, LangGraph, Inngest own cross-machine workflow topology and durable state. thread-phase fits *inside* a node — owns the streaming tool-use loop, the per-node concurrency cap, the event log. Phase code makes no assumptions about who owns the outer event loop or persistence layer.

It's also useful as a standalone batch runner (`JobRunner` + sqlite event log + SSE streaming) for workloads that don't need either of the above.

## What thread-phase is *not* for

- DAG / graph framework features (cross-node dependency graphs, declarative edge routing, distributed scheduling). Use Temporal / LangGraph / Inngest, embedding thread-phase inside their nodes.
- Anthropic content-block features (vision, citations, extended thinking). Use the Anthropic SDK directly through the `anthropicAgent` adapter.
- Multi-modal inputs.
- Long-document summarization. The bundled compressor uses opaque markers for old tool results; for hierarchical summarization, do it yourself.

## Stability

Packages follow semver, locked together:

- **patch (2.0.x)** — bug fixes, no API changes
- **minor (2.x.0)** — additive changes (new patterns, new adapters, new optional fields)
- **major (x.0.0)** — breaking changes

Items marked `@internal` in their JSDoc are reachable for advanced callers but **not** covered by semver.

Validated in production by [`Code4me2/chiya-library`](https://github.com/Code4me2/chiya-library) — digest + librarian pipelines, hundreds of articles per day, on systemd timers.

## Development

```bash
npm install      # install all workspace dependencies
npm run build    # build all packages
npm test         # run all tests
npm run typecheck
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the contribution flow.

## License

MIT. See [`LICENSE`](./LICENSE).
