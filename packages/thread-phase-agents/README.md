# thread-phase-agents

Adapter implementations for the `AgentAdapter` protocol from [`thread-phase`](https://github.com/Code4me2/thread-phase). Wraps heterogeneous AI agents — CLI-based coding agents, in-process SDK agents — behind a single uniform shape so thread-phase pipelines can compose them.

## Status

Pre-1.0, work in progress. The protocol surface itself is under active development in `thread-phase` and not yet covered by semver.

## What's in here

Planned adapter set:

- `hermesAgent` — wraps `hermes acp` (ACP-native; rides on the shared ACP chassis)
- `openClawAgent` — wraps `acpx` against the OpenClaw Gateway, with optional `sandbox: 'nemoclaw' | 'local'` mode
- `anthropicAgent` — in-process via `@anthropic-ai/sdk`
- `codexAgent` — in-process via `openai` SDK's Responses API
- `claudeCodeAgent` — subprocess + JSONL streaming + session-file resume

The ACP chassis (`src/acp/`) is the shared backbone for any agent that speaks [Agent Client Protocol](https://agentclientprotocol.com/).

## Install

```bash
npm install thread-phase-agents thread-phase
```

`thread-phase` is a peer dependency. Each adapter that wraps a third-party SDK declares that SDK as an optional peer; install only the ones you use.

## Relationship to thread-phase

[`thread-phase`](https://github.com/Code4me2/thread-phase) owns the `AgentAdapter` protocol, the `Thread` primitive, the canonical `AgentEvent` vocabulary, the `inferenceAgent` (which wraps `runAgentWithTools` against any OpenAI-compatible endpoint), and the conformance suite that every adapter must pass.

This package ships the *other* adapters — the ones that delegate to pre-built coding/research/life agents rather than driving a raw inference loop. Each adapter passes the conformance suite imported from `thread-phase/agents/test-utils`.

## License

MIT.
