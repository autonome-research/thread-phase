/**
 * `inferenceAgent` — the in-tree reference `AgentAdapter`.
 *
 * Wraps `runAgentWithTools` (the OpenAI-compatible inference loop) behind
 * the canonical adapter protocol so the loop becomes one valid adapter
 * alongside future sibling adapters (pi, Claude Code, OpenAI Agents SDK).
 *
 * Declared capabilities:
 *   - streaming:        'text'         (content deltas only)
 *   - cancellation:     'cooperative'  (honors `options.signal` and `abort()`)
 *   - resumption:       'none'
 *   - structuredOutput: 'prompted'     (uses ./structured-output.ts)
 *
 * The run starts lazily: the underlying `runAgentWithTools` is invoked
 * when either `events` is iterated or `result` is awaited, whichever comes
 * first. Translation rules from runner stream events → canonical
 * `AgentEvent`s are documented inline on the `onStreamEvent` callback.
 *
 * @internal
 */

import {
  runAgentWithTools,
  type AgentConfig,
  type AgentRunResult as RunnerResult,
  type AgentRunnerOptions,
  type AgentStreamEvent,
} from '../agent/index.js';
import type { Message } from '../messages.js';
import {
  defineAgentAdapter,
  type AgentAdapterMeta,
  type AgentEvent,
  type AgentEventBus,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
} from './protocol.js';
import { serializeError } from './serialize-error.js';
import {
  applyStructuredOutputPrompt,
  parseStructuredFromText,
  type StructuredOutputConfig,
} from './structured-output.js';

const ADAPTER_ID = 'inference';

/**
 * Configuration for the in-tree inference adapter. Wraps the same inputs
 * `runAgentWithTools` already takes plus an optional structured-output spec.
 *
 * @internal
 */
export interface InferenceAgentConfig {
  /** Agent config passed to `runAgentWithTools`. */
  config: AgentConfig;
  /** Initial messages. The adapter prepends/appends none on top. */
  messages: Message[];
  /**
   * Runner options (client, toolExecutor, cache, etc.). The adapter wires
   * `signal` and `onStreamEvent` itself; pre-existing fields on this object
   * are forwarded unchanged.
   */
  runnerOptions: Omit<AgentRunnerOptions, 'signal' | 'onStreamEvent'>;
  /** Optional structured-output spec (prompted path). */
  outputSchema?: StructuredOutputConfig;
}

/**
 * The adapter metadata, suitable for registration alongside future siblings.
 *
 * @internal
 */
export const inferenceAgent: AgentAdapterMeta<InferenceAgentConfig> = defineAgentAdapter({
  id: ADAPTER_ID,
  capabilities: {
    streaming: 'text',
    cancellation: 'cooperative',
    resumption: 'none',
    structuredOutput: 'prompted',
  },
  adapter: createInferenceAdapter,
});

function createInferenceAdapter(
  config: InferenceAgentConfig,
  options: AgentRunOptions = {},
): AgentRun {
  const source = ADAPTER_ID;
  const traceId = options.traceId;
  const bus = options.eventBus;

  // Unified cancellation: `abort()` and any external signal feed the same
  // controller, so the runner only watches one signal.
  const controller = new AbortController();
  let abortRequested = false;
  const requestAbort = (reason?: string): void => {
    if (abortRequested) return;
    abortRequested = true;
    try {
      controller.abort(reason);
    } catch {
      // Older runtimes throw when aborting twice; the guard above already
      // covers the common case.
    }
  };
  if (options.signal) {
    if (options.signal.aborted) {
      requestAbort(typeof options.signal.reason === 'string' ? options.signal.reason : 'aborted');
    } else {
      options.signal.addEventListener('abort', () => {
        requestAbort(
          typeof options.signal!.reason === 'string' ? options.signal!.reason : 'aborted',
        );
      });
    }
  }

  // Unbounded queue-backed AsyncIterable. Single producer (the runner
  // bridging callback), single consumer (whoever iterates `run.events`).
  // The producer never blocks: if no waiter is parked, events queue.
  const queue: AgentEvent[] = [];
  const waiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];
  let streamClosed = false;

  const pushEvent = (event: AgentEvent): void => {
    if (streamClosed) return;
    if (bus) {
      try {
        bus.emit(event);
      } catch {
        // Bus errors must not poison the run; the bus implementation is
        // expected to swallow handler errors itself.
      }
    }
    const next = waiters.shift();
    if (next) {
      next({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  const closeStream = (): void => {
    if (streamClosed) return;
    streamClosed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w({ value: undefined, done: true });
    }
  };

  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      return {
        next(): Promise<IteratorResult<AgentEvent>> {
          if (queue.length > 0) {
            const value = queue.shift()!;
            return Promise.resolve({ value, done: false });
          }
          if (streamClosed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<AgentEvent>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<AgentEvent>> {
          // Consumer abandoned the iterator; close cleanly so no waiters
          // hang. Does not abort the run — the result promise still
          // resolves on its own timeline.
          closeStream();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  // Stream-event bridge: translate runner events to canonical AgentEvents.
  //
  // Tricky ordering: the runner emits `round_complete` BEFORE the
  // `tool_call_started` events of that round (tool calls are emitted
  // post-decode, immediately after the round marker, then executed). In
  // canonical semantics, a `turn_end` belongs *after* its turn's tool
  // calls — so we defer emission: when `round_complete` fires, stash a
  // pending turn_end keyed by the text accumulated so far. The subsequent
  // `tool_call_started`s of that same round contribute to its count. The
  // pending turn_end is flushed when EITHER another round begins (first
  // content_delta of the next round) OR the run ends (`flushPendingTurn`
  // called from runOnce).
  let turnText = '';
  let pendingTurnText: string | null = null;
  let pendingTurnToolCalls = 0;

  const flushPendingTurn = (): void => {
    if (pendingTurnText === null) return;
    pushEvent({
      type: 'turn_end',
      source,
      traceId,
      assistantText: pendingTurnText,
      toolCallCount: pendingTurnToolCalls,
    });
    pendingTurnText = null;
    pendingTurnToolCalls = 0;
  };

  const onStreamEvent = (e: AgentStreamEvent): void => {
    switch (e.type) {
      case 'content_delta':
        // First content of a new turn flushes the prior pending turn_end.
        if (pendingTurnText !== null) flushPendingTurn();
        turnText += e.delta;
        pushEvent({ type: 'text', source, traceId, delta: e.delta });
        break;
      case 'tool_call_started':
        pendingTurnToolCalls += 1;
        pushEvent({
          type: 'tool_call',
          source,
          traceId,
          id: e.toolCall.id,
          name: e.toolCall.name,
          input: e.toolCall.input,
        });
        break;
      case 'tool_call_complete':
        pushEvent({
          type: 'tool_result',
          source,
          traceId,
          id: e.toolCall.id,
          name: e.toolCall.name,
          output: e.result.content,
          isError: false,
        });
        break;
      case 'round_complete':
        // Capture the turn's text and arm the pending turn_end. Tool-call
        // counting continues against this pending entry until it's flushed.
        pendingTurnText = turnText;
        turnText = '';
        break;
    }
  };

  // Lazy start: kick off the underlying runner the first time either
  // `events` is iterated or `result` is awaited. The promise itself acts
  // as the memoization barrier.
  let started = false;
  let runPromise: Promise<AgentRunResult> | null = null;

  const startIfNeeded = (): Promise<AgentRunResult> => {
    if (runPromise) return runPromise;
    started = true;
    runPromise = runOnce();
    return runPromise;
  };

  async function runOnce(): Promise<AgentRunResult> {
    // The outer try/catch is purely defensive — `runAgentWithTools`
    // already swallows its own errors into a `finishReason: 'error'`
    // result, but we surface anything that slips through as an error
    // event + synthetic result.
    pushEvent({ type: 'agent_start', source, traceId });

    // Apply prompted-output instruction up front, if requested.
    const effectiveConfig: AgentConfig = config.outputSchema
      ? {
          ...config.config,
          systemPrompt: applyStructuredOutputPrompt(config.config.systemPrompt, config.outputSchema),
        }
      : config.config;

    let runnerResult: RunnerResult;
    try {
      runnerResult = await runAgentWithTools(
        effectiveConfig,
        config.messages,
        {
          ...config.runnerOptions,
          signal: controller.signal,
          onStreamEvent,
        },
        config.config.name,
      );
    } catch (err) {
      // Defensive path: emit error + agent_end + synthesize a result.
      flushPendingTurn();
      pushEvent({
        type: 'error',
        source,
        traceId,
        error: serializeError(err),
        transient: false,
      });
      const reason = abortRequested ? 'aborted' : 'error';
      pushEvent({ type: 'agent_end', source, traceId, reason });
      closeStream();
      return {
        text: '',
        finishReason: reason,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        executedToolCalls: [],
      };
    }

    // Flush any pending turn_end armed during the last round_complete.
    flushPendingTurn();

    // If the runner reported 'error' but we asked for abort, override
    // the finish reason — cancellation has a first-class encoding in
    // the canonical vocabulary.
    let finishReason: AgentRunResult['finishReason'] = runnerResult.finishReason;
    if (abortRequested) {
      finishReason = 'aborted';
    } else if (finishReason === 'error') {
      // The runner encoded an error inside the result; surface it as an
      // explicit error event so consumers see the same shape as the
      // defensive path above.
      const message = tryExtractErrorMessage(runnerResult.text);
      pushEvent({
        type: 'error',
        source,
        traceId,
        error: { name: 'AgentRunError', message },
        transient: false,
      });
    }

    // Build the canonical result. The runner's `AgentRunResult` is
    // assignable to ours (required → optional widening), but we
    // re-shape explicitly so future changes to either side don't
    // silently couple.
    const parsed = config.outputSchema
      ? safeParseStructured(runnerResult.text, config.outputSchema)
      : undefined;

    const result: AgentRunResult = {
      text: runnerResult.text,
      finishReason,
      usage: runnerResult.usage,
      executedToolCalls: runnerResult.executedToolCalls,
      activity: runnerResult.activity,
      parsed,
    };

    pushEvent({ type: 'agent_end', source, traceId, reason: finishReason });
    closeStream();
    return result;
  }

  return {
    events: lazyEvents(events, startIfNeeded),
    get result(): Promise<AgentRunResult> {
      return startIfNeeded();
    },
    abort(reason?: string): void {
      requestAbort(reason);
      // If the run hasn't started yet, kick it off now so the queued
      // abort takes effect — otherwise `result` would never resolve.
      if (!started) startIfNeeded();
    },
  };
}

/**
 * Best-effort extraction of an embedded error message from the runner's
 * synthetic JSON error payload. Falls back to the raw text when the shape
 * doesn't match.
 */
function tryExtractErrorMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      '_error' in parsed &&
      typeof (parsed as { message?: unknown }).message === 'string'
    ) {
      return (parsed as { message?: unknown }).message as string;
    }
  } catch {
    // not JSON
  }
  return text || 'agent error';
}

/**
 * Wrap the queue-backed iterable so consumers that iterate `events`
 * implicitly start the run. Without this, awaiting `result` first would be
 * fine, but iterating `events` first would deadlock on an empty queue.
 */
function lazyEvents(
  inner: AsyncIterable<AgentEvent>,
  start: () => Promise<unknown>,
): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      void start();
      return inner[Symbol.asyncIterator]();
    },
  };
}

/**
 * Run the prompted-output parser without throwing — failures leave
 * `parsed` undefined, which the caller can detect and decide whether to
 * retry via `followUp()`. The thrown error is intentionally swallowed
 * because `result` must always resolve; consumers that need the parse
 * error subscribe to `events` (no error event is emitted for parse
 * failures — the missing `parsed` field is the signal).
 */
function safeParseStructured(text: string, spec: StructuredOutputConfig): unknown {
  try {
    return parseStructuredFromText(text, spec);
  } catch {
    return undefined;
  }
}

// Re-exported for callers that need to wire an event bus before the run.
export type { AgentEventBus };
