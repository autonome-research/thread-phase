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
export declare function composeAbort(external?: AbortSignal): CompositeAbort;
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
export declare function createEventQueue(bus?: AgentEventBus): EventQueue;
/**
 * Wrap an inner iterable so that iterating it triggers a lazy-start
 * callback. Adapter `events` property uses this to ensure that iterating
 * events alone (without awaiting `result`) still kicks off the run —
 * otherwise the iterator would park a waiter on an empty queue with no
 * producer, deadlocking.
 *
 * @internal
 */
export declare function lazyEvents(inner: AsyncIterable<AgentEvent>, start: () => void): AsyncIterable<AgentEvent>;
//# sourceMappingURL=run-helpers.d.ts.map