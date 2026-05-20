/**
 * Decorate an `AgentAdapter` with automatic memory recall + remember
 * via a caller-supplied `MemoryProvider`.
 *
 * The wrapper:
 *
 *   1. Reads `runOptions.memoryProvider` at call time. If none is in
 *      scope, the wrapper is a no-op pass-through — caller can decorate
 *      an adapter once and decide per-call whether memory applies.
 *   2. Before invoking the inner adapter, calls `provider.recall(scope, query?)`
 *      and splices the recalled string into the config via the
 *      `inject` callback. The inject signature is adapter-specific
 *      because each adapter shapes its prompt field differently
 *      (config.systemPrompt vs config.instructions vs config.prompt vs
 *      runnerOptions etc.).
 *   3. Tees every emitted event into a capture buffer (for the later
 *      `remember` call) AND into the caller's `options.eventBus` if
 *      present. Pass-through; no events added or dropped.
 *   4. After the inner run's `agent_end`, calls `provider.remember(scope, captured)`
 *      before resolving the wrapped run's `result`. Failures of either
 *      `recall` or `remember` surface as `native` events on the bus
 *      (`memory:recall_failed` / `memory:remember_failed`); the run
 *      itself never fails because of memory.
 *
 * @internal
 */

import { createEventBus } from './event-bus.js';
import type {
  AgentAdapterMeta,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
  AgentRunResult,
  MemoryScope,
} from './protocol.js';
import { serializeError } from './serialize-error.js';

/** @internal */
export interface WithMemoryOptions<TConfig> {
  /** Identity scope (`userId` required; `appId` / `sessionId` optional). */
  scope: MemoryScope;
  /**
   * Splice the recalled memory string into the inner adapter's config.
   * Each adapter shapes its prompt field differently; the caller knows
   * the adapter type and where the memory belongs.
   */
  inject: (config: TConfig, memory: string) => TConfig;
  /**
   * Optional: derive a query string from the config to refine recall.
   * Useful when the recall backend supports semantic search (Honcho's
   * `.chat()` interprets the query as the question being asked).
   * Default: no query (provider gets `undefined`).
   */
  query?: (config: TConfig) => string | undefined;
}

/**
 * Wrap an adapter so each invocation auto-recalls memory before the run
 * and auto-remembers events after. Behavior is gated on the presence
 * of `options.memoryProvider` at call time — no provider, no memory
 * activity.
 *
 * @internal
 */
export function withMemory<TConfig>(
  meta: AgentAdapterMeta<TConfig>,
  opts: WithMemoryOptions<TConfig>,
): AgentAdapterMeta<TConfig> {
  return {
    id: meta.id,
    capabilities: meta.capabilities,
    adapter: (config, runOptions): AgentRun => {
      const provider = runOptions?.memoryProvider;
      if (!provider) {
        // No provider in scope — transparent passthrough.
        return meta.adapter(config, runOptions);
      }

      // Inner bus captures every event for the eventual remember() call
      // AND mirrors to the caller's bus (if any). Pass-through bus, not
      // a replacement.
      const innerBus = createEventBus();
      const captured: AgentEvent[] = [];
      const userBus = runOptions?.eventBus;
      innerBus.on((event) => {
        captured.push(event);
        if (userBus) {
          try {
            userBus.emit(event);
          } catch {
            // bus implementation is responsible for its own subscriber errors
          }
        }
      });

      // Lazy start: recall + inject must complete before the inner adapter
      // is invoked. We can't await here (adapter must return synchronously)
      // so the inner run resolves on first events-iteration or result-await
      // via the standard memoized-promise pattern.
      let innerRunPromise: Promise<AgentRun> | null = null;
      const innerOptions: AgentRunOptions = {
        ...(runOptions ?? {}),
        eventBus: innerBus,
      };

      const getInnerRun = (): Promise<AgentRun> => {
        if (innerRunPromise) return innerRunPromise;
        innerRunPromise = (async () => {
          let recalled = '';
          try {
            const query = opts.query?.(config);
            recalled = await provider.recall(opts.scope, query);
          } catch (err) {
            innerBus.emit({
              type: 'native',
              source: meta.id,
              kind: 'memory:recall_failed',
              payload: { error: serializeError(err) },
            });
          }
          const effective = opts.inject(config, recalled);
          return meta.adapter(effective, innerOptions);
        })();
        return innerRunPromise;
      };

      // Single-consumer guard on the wrapped events iterable. The inner
      // run also guards its own events; the wrapper's guard catches the
      // case where the wrapped run is iterated twice before inner exists.
      let iteratorVended = false;

      const events: AsyncIterable<AgentEvent> = {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          if (iteratorVended) {
            throw new Error(
              'AgentRun.events is single-consumer; iterate it once. Use AgentEventBus (options.eventBus) for multi-subscriber fan-out.',
            );
          }
          iteratorVended = true;
          let innerIterator: AsyncIterator<AgentEvent> | null = null;
          const ensureIterator = async (): Promise<AsyncIterator<AgentEvent>> => {
            if (innerIterator) return innerIterator;
            const run = await getInnerRun();
            innerIterator = run.events[Symbol.asyncIterator]();
            return innerIterator;
          };
          return {
            async next(): Promise<IteratorResult<AgentEvent>> {
              const it = await ensureIterator();
              return it.next();
            },
            async return(): Promise<IteratorResult<AgentEvent>> {
              if (innerIterator?.return) {
                return innerIterator.return();
              }
              return { value: undefined, done: true };
            },
          };
        },
      };

      const result: Promise<AgentRunResult> = (async () => {
        const run = await getInnerRun();
        const inner = await run.result;
        try {
          await provider.remember(opts.scope, captured);
        } catch (err) {
          innerBus.emit({
            type: 'native',
            source: meta.id,
            kind: 'memory:remember_failed',
            payload: { error: serializeError(err) },
          });
        }
        return inner;
      })();

      return {
        events,
        result,
        abort(reason?: string): void {
          // Propagate abort once the inner run exists. If recall is still
          // in flight, the abort takes effect right after recall resolves.
          void getInnerRun().then((r) => r.abort(reason));
        },
      };
    },
  };
}
