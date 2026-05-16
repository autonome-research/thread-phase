/**
 * AgentAdapter protocol — the type surface every adapter speaks.
 *
 * Adapters wrap heterogeneous coding-agent runtimes (the in-tree inference
 * loop, pi, Claude Code, OpenAI Agents SDK, ...) behind a single shape so
 * thread-phase patterns can compose them uniformly. The protocol is types
 * and pure utilities; runtime adapters live in sibling packages.
 *
 * @internal — surface is in development and not covered by semver until
 * AgentAdapter v1 ships. See `potential_feature.md` for the design spec.
 */

import type { FinishReason, UsageInfo, AgentRunResult as RunnerResult } from '../agent/types.js';

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
 * @internal
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
 * @internal
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
 * @internal
 */
export type AgentEvent =
  | { type: 'agent_start';  source: string; traceId?: string; resumeToken?: ResumeToken }
  | { type: 'text';         source: string; traceId?: string; delta: string }
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
 * @internal
 */
export type AgentFinishReason = FinishReason | 'aborted';

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Adapter run result. Strict superset of the runner `AgentRunResult` shape:
 * every field on the existing runner result is present here, with adapter
 * additions (`parsed`, `resumeToken`, `messages`) as optional fields and a
 * widened `finishReason` to include `'aborted'`.
 *
 * @internal
 */
export interface AgentRunResult extends Omit<RunnerResult, 'finishReason'> {
  finishReason: AgentFinishReason;
  /** Populated when the adapter was given an `outputSchema`. */
  parsed?: unknown;
  /** Adapter-produced continuation hint, persisted for a later run. */
  resumeToken?: ResumeToken;
  /**
   * Adapter-native message log when available. Typed loosely because each
   * adapter preserves a different fidelity (pi blocks, Claude Code content
   * arrays, OpenAI reasoning items); consumers that need typed access
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
 * @internal
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
 * @internal
 */
export interface AgentEventBus {
  emit(event: AgentEvent): void;
  on(handler: (event: AgentEvent) => void | Promise<void>): () => void;
}

// ---------------------------------------------------------------------------
// Memory (re-exported from ./memory.js when that module lands)
// ---------------------------------------------------------------------------

/**
 * Scope key for a memory provider. `userId` is required so backends with
 * per-user isolation (Honcho, Letta) can partition; `appId` and `sessionId`
 * narrow the scope further when an implementation supports nesting.
 *
 * @internal
 */
export interface MemoryScope {
  userId: string;
  appId?: string;
  sessionId?: string;
}

/**
 * Pluggable cross-run memory. thread-phase ships no implementations; callers
 * wire one via `AgentRunOptions.memoryProvider`. Implementations are not
 * required to provide read-your-writes consistency.
 *
 * @internal
 */
export interface MemoryProvider {
  recall(scope: MemoryScope, query?: string): Promise<string>;
  remember(scope: MemoryScope, events: ReadonlyArray<AgentEvent>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

/**
 * Options passed to every adapter invocation. All fields are optional;
 * adapters ignore the ones they can't honor (after declaring so via
 * `AgentCapabilities`).
 *
 * @internal
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
 * @internal
 */
export interface AgentRun<TResult extends AgentRunResult = AgentRunResult> {
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<TResult>;
  abort(reason?: string): void;
}

/**
 * Subtype for adapters that support mid-stream steering. Sibling packages
 * (the `thread-phase-agents` extension surface) return this from adapters
 * whose underlying runtime accepts in-flight messages. Core patterns target
 * `AgentRun`; consumers that need steering narrow to `SteerableAgentRun`.
 *
 * @internal
 */
export interface SteerableAgentRun<TResult extends AgentRunResult = AgentRunResult>
  extends AgentRun<TResult> {
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
}

/**
 * The adapter signature. Must return synchronously — the run starts lazily
 * when either `events` is iterated or `result` is awaited.
 *
 * @internal
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
 * @internal
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
 * @internal
 */
export function defineAgentAdapter<TConfig, TResult extends AgentRunResult = AgentRunResult>(
  meta: AgentAdapterMeta<TConfig, TResult>,
): AgentAdapterMeta<TConfig, TResult> {
  return meta;
}
