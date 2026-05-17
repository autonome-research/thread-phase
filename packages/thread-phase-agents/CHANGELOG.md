# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **ACP chassis is now steerable.** Each ACP session can take multiple `session/prompt` requests; the chassis now drains a follow-up queue between turns so callers can stack prompts on the same session without re-spawning the agent. Callers narrow with `isSteerable(run)` (from `thread-phase/agents`) and call `run.followUp('also do X')` — the chassis sends it as another `session/prompt` after the current response completes. `run.events` streams events from every turn in order; `run.result` resolves with the LAST turn's `finishReason`. `steer()` is wired but rejects with a clear capability error — ACP's `session/prompt` is discrete, no mid-generation injection.
- Each prompt cycle now emits a canonical `turn_end` event (was previously omitted). Single-turn runs see one `turn_end` + `agent_end`; multi-turn runs see one `turn_end` per prompt cycle. `turnAccumulator.endTurn()` (added in upstream `thread-phase`) handles the accumulation.
- `hermesAgent` and `openClawAgent` inherit `followUp` semantics through the chassis automatically — no per-wrapper code change.
- 95 tests pass (was 89; +6 for `followUp` / `steer` / `isSteerable` and multi-turn `turn_end` emission).

### Added

Initial adapter set on top of [`thread-phase`](https://github.com/Code4me2/thread-phase) v1.3.0's `AgentAdapter` protocol:

- **`acpAgent`** — the Agent Client Protocol chassis. Spawns any ACP-speaking subprocess, parses NDJSON JSON-RPC over stdio, drives the full `initialize → session/new → session/prompt → session/cancel` lifecycle. Translates `session/update` notifications to canonical AgentEvents (`agent_message_chunk` → text, `agent_thought_chunk` → thinking, `tool_call`/`tool_call_update` → tool_call/tool_result, everything else → native). Forceful cancellation; opaque resumption via ACP session ids.
- **`hermesAgent`** — thin wrapper that spawns `hermes acp` via the ACP chassis. Defaults: executable `hermes`, args `['acp']`. Sessions persist in Hermes's own `~/.hermes/state.db`.
- **`openClawAgent`** — wraps `acpx` against the OpenClaw Gateway. `sandbox: 'nemoclaw'` routes the command through `nemoclaw connect` so the agent runs inside NemoClaw's OpenShell sandbox.
- **`anthropicAgent`** — in-process via `@anthropic-ai/sdk`. Streams from `client.messages.stream`, translates `text_delta` → text, `thinking_delta` → thinking, accumulated `input_json_delta` per tool_use block → tool_call with parsed JSON. Stop reasons mapped to canonical (`end_turn`/`stop_sequence` → stop, `max_tokens` → length, `tool_use` → tool_calls, `refusal` → content_filter).
- **`codexAgent`** — in-process via the OpenAI SDK's Responses API (the same surface the Codex CLI wraps; we call it directly, like hermes does). Native `response-id` resumption via `previousResponseId` → `previous_response_id` request param.
- **`claudeCodeAgent`** — subprocess + stream-json parser. Spawns `claude --print --output-format stream-json --verbose [--resume <id>] <prompt>` and translates the NDJSON output. Forgiving by design: unrecognized line shapes become `native { kind: 'claude-code:*' }` events rather than errors. Forceful cancellation, opaque resumption via session ids.

### Infrastructure

- All adapters use the `composeAbort` / `createEventQueue` / `lazyEvents` / `TurnAccumulator` helpers from `thread-phase/agents`, so per-adapter code is the translation logic and nothing else.
- Every adapter passes the 14-test `runAdapterConformance` suite from `thread-phase/agents/test-utils`. Plus 5–10 adapter-specific integration tests each — total 89 tests.
- Real-binary-free CI: `@anthropic-ai/sdk` and OpenAI client are mocked via dependency injection; ACP and Claude Code adapters run against subprocess stubs in `__tests__/fixtures/`. No `claude` / `hermes` / `acpx` / API keys needed to pass the suite.

### Notes

- This package is pre-1.0; expect the `AcpAgentConfig`, `HermesAgentConfig`, etc. surfaces to evolve as real-binary integration surfaces churn.
- Peer dependency on `thread-phase ^1.3.0`. Each adapter's underlying SDK / CLI is the caller's responsibility — install `@anthropic-ai/sdk` only if you import `anthropicAgent`, `openai` only for `codexAgent`, etc.

[Unreleased]: https://github.com/Code4me2/thread-phase-agents/commits/master
