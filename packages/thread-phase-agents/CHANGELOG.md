# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-05-16

First release with a complete adapter set. Seven adapters covering CLI-based coding agents (claude-code, codex CLI) and in-process SDK agents (anthropic, codex Responses, pi), plus the ACP chassis and its two wrappers (hermes, openclaw). All four adapters that have binaries on the development machine (claude-code, hermes, codex-cli, pi) verified end-to-end via real-binary smoke scripts under `scripts/`.

### Added — adapters

- **`codexCliAgent`** — subprocess wrapper around `codex exec --json`. Uses codex's own auth (ChatGPT subscription OAuth or API key, whichever's configured via `codex login`); no `OPENAI_API_KEY` required. Sister adapter to `codexAgent` (which uses the OpenAI SDK Responses API directly). Translates codex's higher-level event vocabulary (`thread.started`, `turn.started`, `item.started`/`item.completed` with type-discriminated items, `turn.completed`) into canonical events. Tool use surfaces as `tool_call` / `tool_result` for `command_execution` items; agent_message items become `text`; reasoning items become `thinking`. Real-binary smoke against codex v0.130.0: passes end-to-end with usage capture and thread-id resumeToken.
- **`piAgent`** — in-process via `@mariozechner/pi-coding-agent`. Calls `createAgentSession`, subscribes to its event stream, translates pi's rich `AgentSessionEvent` union into canonical events. The first adapter in this package where `SteerableAgentRun.steer()` and `.followUp()` **work natively at runtime** — pi accepts mid-stream steering and queued follow-ups, the adapter just forwards. Declares `resumption: 'session-file'` (pi's SessionManager persists conversations to disk at `~/.pi/agent/sessions/`). Real-binary smoke against pi v0.73.1 + local vLLM: passes with thinking events, text deltas, usage capture, and turn_end emission. `@mariozechner/pi-coding-agent` is a runtime dependency.

### Added — injectors

- `injectMemory.codexCli` / `injectMemory.pi` — prepend memory to the prompt (same pattern as claudeCode).
- `injectResume.codexCli` — opaque token → `resumeThreadId`.
- `injectResume.pi` — `session-file` token → `resumeSessionFile`; opaque passes through (caller can set continueSession instead).

### Added — smoke scripts

`scripts/smoke-{claude-code,hermes,codex-cli,pi}.ts` — real-binary smoke tests. Each spawns the actual agent, sends a tiny prompt, prints every canonical event, and reports a pass/fail summary. Run with `npx tsx scripts/smoke-<adapter>.ts [prompt]`.

### Added — earlier in this unreleased cycle

- **`injectMemory`** / **`injectResume`** — pre-built `inject` callbacks for `withMemory` / `withThread` covering every adapter in the package (inference, anthropic, codex, claudeCode, acp, hermes, openClaw). Each knows where its adapter expects memory or a resume token to live. Empty memory passes through unchanged; non-opaque tokens on opaque-only adapters pass through. Removes the boilerplate of writing custom inject callbacks at every call site.
- **Thread bridge** (`threadToTranscript`, `threadToAcpPrompt`, `threadToAnthropicMessages`, `threadToClaudeCodePrompt`, `threadToCodexInput`) — converts a `Thread` from one adapter into the input shape expected by the next. Lossy by design — cross-adapter handoff renders the canonical event log as a source-tagged text transcript. For full fidelity, use same-adapter resumption via `injectResume` instead.
- 26 new tests, 121 sibling tests total. (Codex-cli and pi unit tests deferred — the adapters are real-binary-tested via smoke scripts.)

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

[Unreleased]: https://github.com/Code4me2/thread-phase-agents/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Code4me2/thread-phase-agents/releases/tag/v0.1.0
