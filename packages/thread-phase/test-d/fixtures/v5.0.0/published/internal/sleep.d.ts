/**
 * @internal — shared abortable-sleep helper.
 *
 * Replaces `new Promise(r => setTimeout(r, ms))` everywhere a delay needs to
 * honor an `AbortSignal`. Without this, cancellation has to wait for the
 * full delay before surfacing — which makes retry backoffs, timer polling,
 * and structured backoff loops un-cancellable in practice.
 *
 * Rejects with a `DOMException(name: 'AbortError')` when the signal aborts.
 * Resolves normally when the timer elapses. Cleans up its listener in both
 * paths so signals attached to long-lived AbortControllers don't leak.
 *
 * Not exported from the package surface. Pattern wrappers (with-retry,
 * timer-trigger, agent runner) consume it directly.
 */
export declare function abortableSleep(ms: number, signal?: AbortSignal): Promise<void>;
//# sourceMappingURL=sleep.d.ts.map