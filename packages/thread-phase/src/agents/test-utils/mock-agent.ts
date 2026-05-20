/**
 * Scripted `AgentAdapter` for tests.
 *
 * `createMockAgent` returns a `AgentAdapterMeta` whose adapter replays a
 * configured sequence of `AgentEvent`s and resolves with a configured
 * `AgentRunResult`. The mock honors the protocol's lifecycle invariants:
 * exactly one `agent_start`, exactly one trailing `agent_end`, `result`
 * always resolves, `abort()` is idempotent, `options.signal` is observed.
 *
 * Used by in-tree tests targeting the AgentAdapter surface and by the
 * conformance suite as the self-test adapter.
 *
 * @internal
 */

import {
  defineAgentAdapter,
  type AgentAdapterMeta,
  type AgentCapabilities,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
} from '../protocol.js';

/**
 * Scripted invocation of the mock adapter. The adapter emits exactly the
 * events in `events`, in order, then resolves `result` with the scripted
 * value. Lifecycle events (`agent_start`, `agent_end`) are added by the
 * adapter — do not include them in `events`.
 *
 * @internal
 */
export interface MockAgentConfig {
  /** Events to emit, in order. Should NOT include agent_start or agent_end. */
  events: ReadonlyArray<AgentEvent>;
  /** Final result. agent_end.reason will mirror result.finishReason. */
  result: AgentRunResult;
  /**
   * Delay in ms between scripted events. 0 = a microtask hop per event.
   * Default 0. Use a positive value to exercise consumers that need to
   * interleave with async work.
   */
  perEventDelayMs?: number;
  /**
   * If set, the adapter throws this when called. Used to test how callers
   * handle adapter-construction-time failures (vs run-time errors which
   * should still resolve `result`).
   */
  throwOnConstruct?: Error;
}

/**
 * Override knobs for the mock adapter's metadata. Defaults match a minimal
 * adapter: `streaming: 'text'`, `cancellation: 'cooperative'`,
 * `resumption: 'none'`, `structuredOutput: 'none'`.
 *
 * @internal
 */
export interface CreateMockAgentOptions {
  id?: string;
  capabilities?: Partial<AgentCapabilities>;
}

/**
 * Default capabilities used when none are overridden.
 *
 * @internal
 */
export const MOCK_DEFAULT_CAPABILITIES: AgentCapabilities = {
  streaming: 'text',
  cancellation: 'cooperative',
  resumption: 'none',
  structuredOutput: 'none',
};

/**
 * Build a mock adapter suitable for testing pattern code and any consumer
 * targeting the AgentAdapter protocol.
 *
 * @internal
 */
export function createMockAgent(
  opts: CreateMockAgentOptions = {},
): AgentAdapterMeta<MockAgentConfig> {
  const id = opts.id ?? 'mock';
  const capabilities: AgentCapabilities = {
    ...MOCK_DEFAULT_CAPABILITIES,
    ...opts.capabilities,
  };

  return defineAgentAdapter<MockAgentConfig>({
    id,
    capabilities,
    adapter: (config: MockAgentConfig, options?: AgentRunOptions): AgentRun => {
      if (config.throwOnConstruct) {
        throw config.throwOnConstruct;
      }

      const traceId = options?.traceId;
      const bus = options?.eventBus;
      const externalSignal = options?.signal;
      const localController = new AbortController();
      // AbortSignal.any (Node 20+) composes without manual listeners that
      // would pin our closure if the external signal outlives the run.
      const composite: AbortSignal = externalSignal
        ? AbortSignal.any([externalSignal, localController.signal])
        : localController.signal;

      const emit = (event: AgentEvent): void => {
        if (bus) bus.emit(event);
      };

      // Single-producer queue feeding the AsyncIterable. We push every event
      // (start, scripted, end) into `queue` and the iterator drains it.
      const queue: AgentEvent[] = [];
      const waiters: Array<(value: IteratorResult<AgentEvent>) => void> = [];
      let producerDone = false;

      const push = (event: AgentEvent): void => {
        const waiter = waiters.shift();
        if (waiter) {
          waiter({ value: event, done: false });
        } else {
          queue.push(event);
        }
      };

      const finishIterator = (): void => {
        producerDone = true;
        while (waiters.length > 0) {
          const w = waiters.shift()!;
          w({ value: undefined as unknown as AgentEvent, done: true });
        }
      };

      let resolveResult!: (value: AgentRunResult) => void;
      const resultPromise = new Promise<AgentRunResult>((resolve) => {
        resolveResult = resolve;
      });

      const stamp = <E extends AgentEvent>(event: E): E => {
        // Adapters set `source` to their id; preserve any traceId from options.
        const next = { ...event, source: id } as E;
        if (traceId !== undefined && next.traceId === undefined) {
          (next as { traceId?: string }).traceId = traceId;
        }
        return next;
      };

      const run = async (): Promise<void> => {
        const start: AgentEvent = stamp({ type: 'agent_start', source: id });
        push(start);
        emit(start);

        let aborted = composite.aborted;

        for (const raw of config.events) {
          if (composite.aborted) {
            aborted = true;
            break;
          }
          if (config.perEventDelayMs && config.perEventDelayMs > 0) {
            await delay(config.perEventDelayMs, composite);
          } else {
            // Microtask hop so consumers get a chance to interleave.
            await Promise.resolve();
          }
          if (composite.aborted) {
            aborted = true;
            break;
          }
          const ev = stamp(raw);
          push(ev);
          emit(ev);
        }

        const finishReason = aborted ? 'aborted' : config.result.finishReason;
        const end: AgentEvent = stamp({
          type: 'agent_end',
          source: id,
          reason: finishReason,
          resumeToken: config.result.resumeToken,
        });
        push(end);
        emit(end);
        finishIterator();

        resolveResult(aborted ? { ...config.result, finishReason: 'aborted' } : config.result);
      };

      // Kick off lazily — start when either events is iterated or result
      // is awaited. The protocol requires synchronous return, so we defer
      // the loop to a microtask.
      let started = false;
      const start = (): void => {
        if (started) return;
        started = true;
        // Detach from the caller's stack; errors here must not surface as
        // a synchronous throw from `adapter()`. Any unexpected failure is
        // funneled into an error event + finishReason: 'error'.
        void run().catch((err) => {
          const errEvent: AgentEvent = stamp({
            type: 'error',
            source: id,
            error: serializeMockError(err),
            transient: false,
          });
          push(errEvent);
          emit(errEvent);
          const end: AgentEvent = stamp({
            type: 'agent_end',
            source: id,
            reason: 'error',
          });
          push(end);
          emit(end);
          finishIterator();
          resolveResult({ ...config.result, finishReason: 'error' });
        });
      };

      // Single-consumer guard — matches inferenceAgent's behavior. A second
      // iterator would silently split events between consumers.
      let iteratorVended = false;
      const events: AsyncIterable<AgentEvent> = {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          if (iteratorVended) {
            throw new Error(
              'AgentRun.events is single-consumer; iterate it once. Use AgentEventBus (options.eventBus) for multi-subscriber fan-out.',
            );
          }
          iteratorVended = true;
          start();
          return {
            next(): Promise<IteratorResult<AgentEvent>> {
              if (queue.length > 0) {
                const value = queue.shift()!;
                return Promise.resolve({ value, done: false });
              }
              if (producerDone) {
                return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
              }
              return new Promise<IteratorResult<AgentEvent>>((resolve) => {
                waiters.push(resolve);
              });
            },
            return(): Promise<IteratorResult<AgentEvent>> {
              // Early termination — cancel and drain.
              localController.abort();
              finishIterator();
              return Promise.resolve({ value: undefined as unknown as AgentEvent, done: true });
            },
          };
        },
      };

      const result: Promise<AgentRunResult> = {
        then(onFulfilled, onRejected) {
          start();
          return resultPromise.then(onFulfilled, onRejected);
        },
        catch(onRejected) {
          start();
          return resultPromise.catch(onRejected);
        },
        finally(onFinally) {
          start();
          return resultPromise.finally(onFinally);
        },
        [Symbol.toStringTag]: 'Promise',
      } as Promise<AgentRunResult>;

      return {
        events,
        result,
        abort(_reason?: string): void {
          // Idempotent — AbortController.abort is itself idempotent.
          localController.abort();
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function serializeMockError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'NonError', message: String(err) };
}
