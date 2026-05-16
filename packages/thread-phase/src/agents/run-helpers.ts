/**
 * Helpers for adapter authors.
 *
 * Every `AgentAdapter` does the same three things at construction:
 *   1. Compose its abort signal — options.signal plus an internal controller
 *      driven by the returned `abort()` method.
 *   2. Set up a queue-backed `AsyncIterable<AgentEvent>` with a producer
 *      that doesn't block and a consumer that's single-shot (multi-cast
 *      goes through `AgentEventBus`).
 *   3. Defer the actual work to a lazy `runOnce()` that starts when either
 *      `events` is iterated or `result` is awaited, whichever comes first.
 *
 * These helpers capture those patterns so per-adapter code only describes
 * the translation between its underlying runtime and canonical
 * `AgentEvent`s. The patterns themselves stay invariant.
 *
 * @internal
 */

import type { AgentEvent, AgentEventBus } from './protocol.js';

// ---------------------------------------------------------------------------
// composeAbort
// ---------------------------------------------------------------------------

/** @internal */
export interface CompositeAbort {
  /** Signal an adapter passes down to its underlying runtime. Aborts when EITHER input does. */
  readonly signal: AbortSignal;
  /** The internal controller driven by the adapter's `abort()` method. */
  readonly controller: AbortController;
}

/**
 * Compose an optional external `AbortSignal` (from `AgentRunOptions.signal`)
 * with an internal controller into a single signal. Uses `AbortSignal.any`
 * (Node 20+), so there's no manual listener that would pin a closure if
 * the external signal outlives the run.
 *
 * @internal
 */
export function composeAbort(external?: AbortSignal): CompositeAbort {
  const controller = new AbortController();
  const signal = external
    ? AbortSignal.any([external, controller.signal])
    : controller.signal;
  return { signal, controller };
}

// ---------------------------------------------------------------------------
// createEventQueue
// ---------------------------------------------------------------------------

/** @internal */
export interface EventQueue {
  /** Producer — emit an event. Mirrors to the bus if one was supplied. Non-blocking. */
  push(event: AgentEvent): void;
  /** Mark the stream complete. Drains parked waiters with `done: true`. Idempotent. */
  close(): void;
  /** Whether `close()` has been called. */
  isClosed(): boolean;
  /** The consumer-side iterable. Single-shot — vending twice throws. */
  readonly events: AsyncIterable<AgentEvent>;
}

/**
 * Single-producer / single-consumer queue with optional `AgentEventBus`
 * mirroring. The producer never blocks; events queue when no consumer is
 * waiting. The consumer is single-shot — vending the iterator twice
 * throws (use `AgentEventBus` for multi-subscriber fan-out).
 *
 * Bus errors are swallowed: the producer must never fail because of a
 * misbehaving subscriber. Bus implementations are responsible for
 * containing their own handler errors.
 *
 * @internal
 */
export function createEventQueue(bus?: AgentEventBus): EventQueue {
  const queued: AgentEvent[] = [];
  const waiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];
  let closed = false;
  let iteratorVended = false;

  const push = (event: AgentEvent): void => {
    if (closed) return;
    if (bus) {
      try {
        bus.emit(event);
      } catch {
        // bus implementation handles its own subscriber errors
      }
    }
    const next = waiters.shift();
    if (next) {
      next({ value: event, done: false });
    } else {
      queued.push(event);
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w({ value: undefined, done: true });
    }
  };

  const events: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      if (iteratorVended) {
        throw new Error(
          'AgentRun.events is single-consumer; iterate it once. Use AgentEventBus (options.eventBus) for multi-subscriber fan-out.',
        );
      }
      iteratorVended = true;
      return {
        next(): Promise<IteratorResult<AgentEvent>> {
          if (queued.length > 0) {
            return Promise.resolve({ value: queued.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<AgentEvent>>((resolve) => {
            waiters.push(resolve);
          });
        },
        return(): Promise<IteratorResult<AgentEvent>> {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    push,
    close,
    isClosed: () => closed,
    events,
  };
}

// ---------------------------------------------------------------------------
// lazyEvents
// ---------------------------------------------------------------------------

/**
 * Wrap an inner iterable so that iterating it triggers a lazy-start
 * callback. Adapter `events` property uses this to ensure that iterating
 * events alone (without awaiting `result`) still kicks off the run —
 * otherwise the iterator would park a waiter on an empty queue with no
 * producer, deadlocking.
 *
 * @internal
 */
export function lazyEvents(
  inner: AsyncIterable<AgentEvent>,
  start: () => void,
): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      start();
      return inner[Symbol.asyncIterator]();
    },
  };
}
