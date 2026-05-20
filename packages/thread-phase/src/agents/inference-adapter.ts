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
  type AgentEventBus,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
} from './protocol.js';
import { composeAbort, createEventQueue, lazyEvents } from './run-helpers.js';
import { serializeError } from './serialize-error.js';
import {
  applyStructuredOutputPrompt,
  parseStructuredFromText,
  type StructuredOutputConfig,
} from './structured-output.js';
import { TurnAccumulator } from './turn-accumulator.js';

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

  const { signal: compositeSignal, controller } = composeAbort(options.signal);
  const queue = createEventQueue(options.eventBus);
  const pushEvent = queue.push;
  const closeStream = queue.close;

  // Stream-event bridge: translate runner events to canonical AgentEvents.
  // The runner emits `round_complete` BEFORE that round's `tool_call_started`
  // events — see `TurnAccumulator` for the deferral pattern that handles
  // this without misattributing tool calls to the wrong turn.
  const turns = new TurnAccumulator(pushEvent, source, traceId);

  const onStreamEvent = (e: AgentStreamEvent): void => {
    switch (e.type) {
      case 'content_delta':
        turns.text(e.delta);
        break;
      case 'tool_call_started':
        turns.toolCall(e.toolCall.id, e.toolCall.name, e.toolCall.input);
        break;
      case 'tool_call_complete':
        turns.toolResult(e.toolCall.id, e.toolCall.name, e.result.content, false);
        break;
      case 'round_complete':
        turns.markTurnEnd();
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
          signal: compositeSignal,
          onStreamEvent,
        },
        config.config.name,
      );
    } catch (err) {
      // Defensive path: emit error + agent_end + synthesize a result.
      turns.close();
      pushEvent({
        type: 'error',
        source,
        traceId,
        error: serializeError(err),
        transient: false,
      });
      const reason = compositeSignal.aborted ? 'aborted' : 'error';
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
    turns.close();

    // If the runner reported 'error' but we asked for abort, override
    // the finish reason — cancellation has a first-class encoding in
    // the canonical vocabulary. `compositeSignal.aborted` reflects both
    // `run.abort()` and `options.signal` paths via AbortSignal.any.
    let finishReason: AgentRunResult['finishReason'] = runnerResult.finishReason;
    if (compositeSignal.aborted) {
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
    let parsed: unknown = undefined;
    let parseError: AgentRunResult['parseError'] = undefined;
    if (config.outputSchema) {
      try {
        parsed = parseStructuredFromText(runnerResult.text, config.outputSchema);
      } catch (err) {
        parseError = serializeError(err);
      }
    }

    const result: AgentRunResult = {
      text: runnerResult.text,
      finishReason,
      usage: runnerResult.usage,
      executedToolCalls: runnerResult.executedToolCalls,
      activity: runnerResult.activity,
      parsed,
      parseError,
    };

    pushEvent({ type: 'agent_end', source, traceId, reason: finishReason });
    closeStream();
    return result;
  }

  return {
    events: lazyEvents(queue.events, startIfNeeded),
    get result(): Promise<AgentRunResult> {
      return startIfNeeded();
    },
    abort(reason?: string): void {
      // AbortController.abort is idempotent — second call is a no-op.
      controller.abort(reason);
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

// Re-exported for callers that need to wire an event bus before the run.
export type { AgentEventBus };
