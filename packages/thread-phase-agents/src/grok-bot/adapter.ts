/**
 * Grok Bot adapter — bridge to a product-owned invoke API.
 *
 * Grok Bot currently has no public CLI or Node SDK that can start, stream,
 * and cancel a turn. This adapter therefore takes an authenticated
 * `GrokBotInvokeClient` supplied by the host product. It deliberately does
 * not fake a transport with files, routines, or UI automation.
 *
 * The invoke client is the product boundary: Cursor/Grok Bot owns account
 * authentication and transport details; this module owns translation into
 * the canonical AgentAdapter lifecycle.
 *
 * @internal
 */

import type { ToolCall, UsageInfo } from '@autonome-research/thread-phase';
import {
  defineAgentAdapter,
  type AgentAdapterMeta,
  type AgentFinishReason,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
  type ResumeToken,
  type SerializableError,
  type StructuredOutputConfig,
} from '@autonome-research/thread-phase/agents';
import {
  TurnAccumulator,
  applyStructuredOutputPrompt,
  composeAbort,
  createEventQueue,
  lazyEvents,
  parseStructuredFromText,
  serializeError,
} from '@autonome-research/thread-phase/agents/authoring';

const ADAPTER_ID = 'grok-bot';
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Request passed to the product-owned invoke client. @internal */
export interface GrokBotInvokeRequest {
  agentId: string;
  prompt: string;
  resumeToken?: string;
}

/** Options passed to the product-owned invoke client. @internal */
export interface GrokBotInvokeOptions {
  signal: AbortSignal;
}

/**
 * Events exposed by the invoke boundary before canonical translation.
 * Names intentionally describe Grok Bot product events rather than adding
 * another general-purpose agent event model.
 *
 * @internal
 */
export type GrokBotInvokeEvent =
  | { type: 'run_accepted'; runId?: string; resumeToken?: string }
  /** One complete user-visible assistant turn. Usage is cumulative for the run. */
  | { type: 'message'; text: string; usage?: UsageInfo }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError?: boolean }
  | { type: 'human_gate'; payload: unknown }
  /** A diagnostic failure. A later completed event may report recovery. */
  | { type: 'error'; error: unknown; transient: boolean }
  | {
      type: 'completed';
      finishReason?: AgentFinishReason;
      resumeToken?: string;
      /** Authoritative cumulative usage for the completed run. */
      usage?: UsageInfo;
    };

/** A remotely running Grok Bot turn. @internal */
export interface GrokBotInvokeRun {
  /** Product run id, used by the client when cancelling. */
  runId: string;
  /** Opaque conversation continuation, when known at run acceptance. */
  resumeToken?: string;
  /** Stream remains pending while a human gate is unresolved. */
  events: AsyncIterable<GrokBotInvokeEvent>;
  /** Must request cancellation of the remote turn. Calls must be idempotent. */
  cancel(reason?: string): void | Promise<void>;
}

/**
 * Authenticated product invoke API. The host obtains Cursor-account auth;
 * callers must not substitute a pasted bot token.
 *
 * @internal
 */
export interface GrokBotInvokeClient {
  startRun(request: GrokBotInvokeRequest, options: GrokBotInvokeOptions): Promise<GrokBotInvokeRun>;
}

/** @internal */
export interface GrokBotAgentConfig {
  agentId: string;
  prompt: string;
  /** Opaque resume from a previous run, if the invoke API supports it. */
  resumeToken?: string;
  /** Wall-clock bound for browser/subagent work. No timeout by default. */
  timeoutMs?: number;
  /** Authenticated Cursor/Grok Bot invoke API supplied by the host product. */
  client: GrokBotInvokeClient;
  /** Optional prompted structured-output spec. */
  outputSchema?: StructuredOutputConfig;
}

/** @internal */
export const grokBotAgent: AgentAdapterMeta<GrokBotAgentConfig> = defineAgentAdapter({
  id: ADAPTER_ID,
  capabilities: {
    streaming: 'turns',
    cancellation: 'cooperative',
    resumption: 'opaque',
    structuredOutput: 'prompted',
  },
  adapter: createGrokBotAdapter,
});

function createGrokBotAdapter(
  config: GrokBotAgentConfig,
  options: AgentRunOptions = {},
): AgentRun {
  const source = ADAPTER_ID;
  const traceId = options.traceId;
  const { signal, controller } = composeAbort(options.signal);
  const queue = createEventQueue(options.eventBus);
  const turns = new TurnAccumulator(queue.push, source, traceId);

  let started = false;
  let runPromise: Promise<AgentRunResult> | null = null;
  let remoteRun: GrokBotInvokeRun | undefined;
  let cancelPromise: Promise<void> | undefined;
  let abortReason: string | undefined;

  const cancelRemote = (): Promise<void> => {
    if (cancelPromise) return cancelPromise;
    if (!remoteRun) return Promise.resolve();
    const run = remoteRun;
    try {
      cancelPromise = Promise.resolve(run.cancel(abortReason)).catch(() => undefined);
    } catch {
      cancelPromise = Promise.resolve();
    }
    return cancelPromise;
  };

  const onAbort = (): void => {
    abortReason = typeof signal.reason === 'string' ? signal.reason : abortReason;
    void cancelRemote();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const startIfNeeded = (): Promise<AgentRunResult> => {
    if (runPromise) return runPromise;
    started = true;
    runPromise = runOnce();
    return runPromise;
  };

  async function runOnce(): Promise<AgentRunResult> {
    let resumeToken: ResumeToken | undefined = config.resumeToken
      ? { kind: 'opaque', data: config.resumeToken }
      : undefined;
    queue.push({ type: 'agent_start', source, traceId, resumeToken });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let outputSchema: StructuredOutputConfig | undefined;
    let text = '';
    let usage: UsageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: AgentFinishReason | undefined;
    let sawError = false;
    const executedToolCalls: ToolCall[] = [];

    const finish = (reason: AgentFinishReason): AgentRunResult => {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      queue.push({ type: 'agent_end', source, traceId, reason, resumeToken });
      queue.close();

      let parsed: unknown;
      let parseError: SerializableError | undefined;
      if (outputSchema && reason !== 'error' && reason !== 'aborted') {
        try {
          parsed = parseStructuredFromText(text, outputSchema);
        } catch (err) {
          parseError = serializeError(err);
        }
      }

      return {
        text,
        finishReason: reason,
        usage,
        executedToolCalls,
        parsed,
        parseError,
        resumeToken,
      };
    };

    const fail = (err: unknown): AgentRunResult => {
      turns.close();
      queue.push({
        type: 'error',
        source,
        traceId,
        error: serializeError(err),
        transient: isTransientError(err),
      });
      return finish(signal.aborted ? 'aborted' : 'error');
    };

    if (config.timeoutMs !== undefined) {
      if (
        !Number.isFinite(config.timeoutMs) ||
        config.timeoutMs <= 0 ||
        config.timeoutMs > MAX_TIMEOUT_MS
      ) {
        return fail(new RangeError(
          `grokBotAgent timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`,
        ));
      }
      timeout = setTimeout(
        () => controller.abort(`Grok Bot timed out after ${config.timeoutMs}ms`),
        config.timeoutMs,
      );
    }

    if (signal.aborted) return finish('aborted');

    let remoteIterator: AsyncIterator<GrokBotInvokeEvent> | undefined;
    try {
      if (!config.client || typeof config.client.startRun !== 'function') {
        throw new Error(
          'grokBotAgent requires an authenticated GrokBotInvokeClient; ' +
            'Grok Bot does not currently expose a public CLI or invoke API',
        );
      }
      outputSchema = config.outputSchema;
      const prompt = outputSchema
        ? `${config.prompt}\n\n${applyStructuredOutputPrompt('', outputSchema)}`
        : config.prompt;
      const startPromise = Promise.resolve().then(() => config.client.startRun(
        { agentId: config.agentId, prompt, resumeToken: config.resumeToken },
        { signal },
      ));
      void startPromise.then((run) => {
        if (!signal.aborted) return;
        remoteRun = run;
        void cancelRemote();
      }, () => undefined);
      remoteRun = await raceWithAbort(startPromise, signal);

      if (remoteRun.resumeToken) {
        resumeToken = { kind: 'opaque', data: remoteRun.resumeToken };
      }
      if (signal.aborted) {
        void cancelRemote();
        return finish('aborted');
      }

      remoteIterator = remoteRun.events[Symbol.asyncIterator]();
      while (true) {
        const next = await raceWithAbort(
          Promise.resolve().then(() => remoteIterator!.next()),
          signal,
        );
        if (next.done) break;
        const event = next.value;
        switch (event.type) {
          case 'run_accepted':
            if (event.resumeToken) resumeToken = { kind: 'opaque', data: event.resumeToken };
            turns.native('grok-bot:run_accepted', event);
            break;
          case 'message':
            text += event.text;
            if (event.usage) usage = { ...event.usage };
            turns.text(event.text);
            // Product usage is cumulative; attaching it to every turn would
            // make consumers that sum turn_end usage overcount the run.
            turns.endTurn();
            break;
          case 'thinking':
            turns.thinking(event.text);
            break;
          case 'tool_call': {
            const input = toToolInput(event.input);
            turns.toolCall(event.id, event.name, input);
            executedToolCalls.push({ id: event.id, name: event.name, input });
            break;
          }
          case 'tool_result':
            turns.toolResult(event.id, event.name, event.output, event.isError ?? false);
            break;
          case 'human_gate':
            turns.native('human_gate', event.payload);
            break;
          case 'error':
            sawError = true;
            queue.push({
              type: 'error',
              source,
              traceId,
              error: serializeError(event.error),
              transient: event.transient,
            });
            break;
          case 'completed':
            if (event.resumeToken) resumeToken = { kind: 'opaque', data: event.resumeToken };
            if (event.usage) usage = { ...event.usage };
            finishReason = event.finishReason ?? 'stop';
            break;
        }
        if (finishReason !== undefined) break;
      }
      if (finishReason !== undefined && remoteIterator.return) {
        // Completion is authoritative. Request stream cleanup, but do not
        // let a broken transport's return() overwrite or indefinitely delay it.
        void Promise.resolve()
          .then(() => remoteIterator!.return!())
          .catch(() => undefined);
      }
    } catch (err) {
      void Promise.resolve()
        .then(() => remoteIterator?.return?.())
        .catch(() => undefined);
      void cancelRemote();
      return fail(err);
    }

    if (signal.aborted) {
      void cancelRemote();
      return finish('aborted');
    }
    if (finishReason === undefined) {
      if (sawError) return finish('error');
      return fail(new Error(`Grok Bot run ${remoteRun.runId} ended without a completed event`));
    }
    if (finishReason === 'error' && !sawError) {
      queue.push({
        type: 'error',
        source,
        traceId,
        error: {
          name: 'GrokBotRunError',
          message: `Grok Bot run ${remoteRun.runId} completed with an error`,
        },
        transient: false,
      });
    }

    return finish(finishReason);
  }

  return {
    events: lazyEvents(queue.events, startIfNeeded),
    get result(): Promise<AgentRunResult> {
      return startIfNeeded();
    },
    abort(reason?: string): void {
      abortReason = reason;
      controller.abort(reason);
      if (!started) startIfNeeded();
    },
  };
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function abortError(signal: AbortSignal): Error {
  const message = typeof signal.reason === 'string' ? signal.reason : 'Grok Bot run aborted';
  return Object.assign(new Error(message), { name: 'AbortError' });
}

function toToolInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

function isTransientError(err: unknown): boolean {
  if (err !== null && typeof err === 'object') {
    const candidate = err as { transient?: unknown; status?: unknown; statusCode?: unknown };
    if (typeof candidate.transient === 'boolean') return candidate.transient;
    const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
    return status === 429 || (typeof status === 'number' && status >= 500);
  }
  return false;
}
