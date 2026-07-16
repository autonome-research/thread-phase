/**
 * AgentAdapter protocol — the type surface every adapter speaks.
 *
 * Adapters wrap heterogeneous coding-agent runtimes (the in-tree inference
 * loop, pi, Claude Code, OpenAI Agents SDK, ...) behind a single shape so
 * thread-phase patterns can compose them uniformly. The protocol is types
 * and pure utilities; runtime adapters live in sibling packages.
 *
 * AgentAdapter v1 ships. See `potential_feature.md` for the design spec.
 */

import type { ActivityEntry, FinishReason, UsageInfo } from '../agent/types.js';
import type { ToolCall } from '../messages.js';
import type { MemoryProvider, MemoryScope } from './memory.js';

export type { MemoryProvider, MemoryScope } from './memory.js';

// ---------------------------------------------------------------------------
// Resumption
// ---------------------------------------------------------------------------

/**
 * Hint an adapter can persist to resume a conversation in a later run.
 *
 * - `response-id` matches OpenAI's `previous_response_id` continuation.
 * - `session-file` is the on-disk transcript used by pi and Claude Code.
 * - `opaque` is the fallback for adapters with proprietary continuation state.
 *
 */
export type ResumeToken =
  | { kind: 'response-id'; id: string; provider: string }
  | { kind: 'session-file'; path: string; messageIndex?: number }
  | { kind: 'opaque'; data: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Cross-process-friendly error shape. Subprocess adapters can only surface
 * serialized errors anyway, so making it uniform avoids a footgun where
 * callers conditionally have raw `Error` instances vs. plain objects.
 *
 */
export interface SerializableError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializableError;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Canonical event vocabulary. Every adapter translates its native event
 * stream into this discriminated union. The `native` variant is the escape
 * hatch for adapter-specific signals (pi compaction, OpenAI handoffs, etc.) —
 * consumers filter by `source` to handle them safely.
 *
 * Ordering invariant: `agent_start` is the first non-`native` event,
 * `agent_end` the last; exactly one of each per run.
 *
 * The `thinking` variant is for adapters that surface reasoning content
 * separately from final text (Anthropic extended thinking, OpenAI Responses
 * reasoning items, pi inner monologue). The in-tree `inferenceAgent` never
 * emits it; OpenAI-compatible chat-completions has no reasoning channel.
 *
 * The `error.transient` flag distinguishes recoverable failures (rate limits,
 * upstream 5xx, intermittent network) from terminal ones (invalid auth,
 * malformed request, schema violation). Adapter authors set `true` only when
 * a sensible retry policy could succeed without user intervention.
 *
 */
export type AgentEvent =
  | { type: 'agent_start';  source: string; traceId?: string; resumeToken?: ResumeToken }
  | { type: 'text';         source: string; traceId?: string; delta: string }
  | { type: 'thinking';     source: string; traceId?: string; delta: string }
  | { type: 'tool_call';    source: string; traceId?: string; id: string; name: string; input: unknown }
  | { type: 'tool_result';  source: string; traceId?: string; id: string; name: string; output: unknown; isError: boolean }
  | { type: 'turn_end';     source: string; traceId?: string; assistantText: string; usage?: UsageInfo; toolCallCount: number }
  | { type: 'agent_end';    source: string; traceId?: string; reason: AgentFinishReason; resumeToken?: ResumeToken }
  | { type: 'error';        source: string; traceId?: string; error: SerializableError; transient: boolean }
  | { type: 'native';       source: string; traceId?: string; kind: string; payload: unknown };

/**
 * Adapter finish reasons. Extends the existing runner `FinishReason` with
 * `'aborted'` so cancellation has a first-class encoding instead of being
 * folded into `'error'`.
 *
 */
export type AgentFinishReason = FinishReason | 'aborted';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Adapter run result. Structural superset of the runner `AgentRunResult`:
 * the runner's required fields appear here with the same shapes, and adapter
 * additions (`activity`, `parsed`, `resumeToken`, `messages`) are optional so
 * non-runner adapters can omit fields they don't naturally produce.
 *
 * The runner's `AgentRunResult` is assignable to this type without change
 * (required → optional is widening); adapters that don't emit activity entries
 * simply leave the field undefined.
 *
 */
export interface AgentRunResult {
  /** Final text output. May be JSON; callers parseJSON or parseStructured. */
  text: string;
  /** Reason the agent stopped, widened with `'aborted'`. */
  finishReason: AgentFinishReason;
  /** Token usage summed across rounds. */
  usage: UsageInfo;
  /** Every tool call the adapter actually executed, in order. */
  executedToolCalls: ToolCall[];
  /** Adapter-native activity log; optional because not every adapter produces one. */
  activity?: ReadonlyArray<ActivityEntry>;
  /** Populated when the adapter was given an `outputSchema` and parsing succeeded. */
  parsed?: unknown;
  /**
   * Populated when the adapter was given an `outputSchema` and parsing
   * FAILED. Mutually exclusive with `parsed` — at most one is set. Callers
   * detect parse failure via `parsed === undefined && parseError !== undefined`
   * and decide whether to retry (typically via `followUp()` on a
   * `SteerableAgentRun`). Parse failures are NOT emitted as `error` events
   * because the agent did its job — the output simply didn't match the schema.
   */
  parseError?: SerializableError;
  /** Adapter-produced continuation hint, persisted for a later run. */
  resumeToken?: ResumeToken;
  /**
   * Adapter-native message log when available. Typed loosely because each
   * adapter preserves a different fidelity (Claude Code content arrays,
   * OpenAI reasoning items, etc.); consumers that need typed access
   * deserialize per `source`.
   */
  messages?: ReadonlyArray<unknown>;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Static introspection over adapter abilities. Patterns and the JobRunner
 * call `requireCapability` against this at construction time so pipelines
 * fail fast before any LLM tokens are spent.
 *
 */
export interface AgentCapabilities {
  streaming: 'text' | 'turns' | 'final-only';
  cancellation: 'cooperative' | 'forceful' | 'none';
  resumption: 'response-id' | 'session-file' | 'opaque' | 'none';
  structuredOutput: 'native' | 'prompted' | 'none';
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

/**
 * Cross-cutting event sink. Orchestrators (JobRunner, audit consumers)
 * create one bus and pass it to every adapter under their scope to observe
 * heterogeneous adapter events through a single seam.
 *
 * Distinct from `AgentRun.events`, which is a single-consumer stream owned
 * by the caller of an individual adapter run. The bus is the multi-subscriber
 * fan-out; the run's events iterable is consumed once.
 *
 */
export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

/** Details reported when an event subscriber throws or rejects. */
export interface AgentEventHandlerFailure {
  /** The exact subscriber function that failed. */
  handler: AgentEventHandler;
  /** The exact event passed to the subscriber. */
  event: AgentEvent;
  /** The thrown or rejected value, normalized to an Error. */
  error: Error;
}

export interface AgentEventBus {
  /**
   * Dispatch synchronously to all current subscribers.
   *
   * Returned promises are observed but never awaited. Subscriber failures do
   * not escape from emit or stop fan-out to the remaining subscribers.
   */
  emit(event: AgentEvent): void;
  on(handler: AgentEventHandler): () => void;
}

/**
 * Additive event-bus surface returned by {@link createEventBus}.
 *
 * `AgentEventBus` intentionally remains the emit/on-only protocol so legacy
 * and third-party bus implementations stay structurally assignable.
 */
export interface ObservableAgentEventBus extends AgentEventBus {
  /**
   * Observe failures from ordinary event subscribers.
   *
   * Error observers are also fire-and-forget. Their own throws and rejections
   * are contained and are not reported recursively.
   */
  onHandlerError(
    handler: (failure: AgentEventHandlerFailure) => void | Promise<void>,
  ): () => void;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

/**
 * Options passed to every adapter invocation. All fields are optional;
 * adapters ignore the ones they can't honor (after declaring so via
 * `AgentCapabilities`).
 *
 */
export interface AgentRunOptions {
  signal?: AbortSignal;
  eventBus?: AgentEventBus;
  traceId?: string;
  memoryProvider?: MemoryProvider;
  memoryScope?: MemoryScope;
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

/**
 * Handle for a single adapter invocation.
 *
 * Lifecycle invariants:
 * - `events` is a single-consumer `AsyncIterable`; iterate it once. Use
 *   `AgentEventBus` for multi-subscriber fan-out.
 * - `result` always resolves, never rejects. Errors are encoded as
 *   `finishReason: 'error'` with a prior `error` event.
 * - `abort()` is idempotent.
 *
 */
export interface AgentRun<TResult extends AgentRunResult = AgentRunResult> {
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<TResult>;
  abort(reason?: string): void;
}

/**
 * Subtype for adapters that support mid-stream steering or post-turn
 * follow-up. Sibling packages (the `@autonome-research/thread-phase-agents` extension surface)
 * return this from adapters whose underlying runtime accepts these calls —
 * e.g. ACP sessions, which can take multiple `session/prompt` requests
 * before the session is closed.
 *
 * `AgentAdapter`'s declared return type stays `AgentRun` for variance
 * (SteerableAgentRun is a subtype). Consumers narrow at the call site
 * via `isSteerable(run)`.
 *
 */
export interface SteerableAgentRun<TResult extends AgentRunResult = AgentRunResult>
  extends AgentRun<TResult> {
  /**
   * Send a steering message mid-stream — only meaningful for runtimes
   * that accept in-flight input (currently none in the bundled adapter
   * set; ACP-based adapters reject with a clear capability error).
   */
  steer(message: string): Promise<void>;
  /**
   * Queue an additional prompt to send after the current prompt response
   * completes. Multiple follow-ups can stack; the chassis drains the
   * queue between turns. Throws after the run has reached `agent_end`.
   */
  followUp(message: string): Promise<void>;
}

/**
 * Type guard for `SteerableAgentRun`. Use at consumer call sites to
 * safely narrow an `AgentRun` returned by an adapter that may or may
 * not be steerable:
 *
 *     const run = hermesAgent.adapter(...);
 *     if (isSteerable(run)) await run.followUp('also do X');
 *
 */
export function isSteerable<TResult extends AgentRunResult>(
  run: AgentRun<TResult>,
): run is SteerableAgentRun<TResult> {
  const candidate = run as Partial<SteerableAgentRun<TResult>>;
  return (
    typeof candidate.followUp === 'function' &&
    typeof candidate.steer === 'function'
  );
}

/**
 * The adapter signature. Must return synchronously — the run starts lazily
 * when either `events` is iterated or `result` is awaited.
 *
 */
export type AgentAdapter<TConfig, TResult extends AgentRunResult = AgentRunResult> = (
  config: TConfig,
  options?: AgentRunOptions,
) => AgentRun<TResult>;

/**
 * Adapter registration metadata. Bundles a stable `id` (used as `source` on
 * every emitted event), a declared `capabilities` descriptor, and the
 * adapter function itself.
 *
 */
export interface AgentAdapterMeta<TConfig, TResult extends AgentRunResult = AgentRunResult> {
  readonly id: string;
  readonly capabilities: AgentCapabilities;
  readonly adapter: AgentAdapter<TConfig, TResult>;
}

/**
 * Identity at runtime; exists for inference and as a hook for future
 * telemetry. Modeled on Vitest's `defineConfig`.
 *
 */
export function defineAgentAdapter<TConfig, TResult extends AgentRunResult = AgentRunResult>(
  meta: AgentAdapterMeta<TConfig, TResult>,
): AgentAdapterMeta<TConfig, TResult> {
  return meta;
}
