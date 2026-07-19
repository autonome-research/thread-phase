/**
 * TimerTrigger — fires at a fixed interval.
 *
 * The canonical scheduled-pipeline source. Replaces `setInterval(() => ..., 60_000)`
 * with the Trigger protocol so the same pipeline-dispatch code works for
 * timer-, webhook-, and queue-driven flows.
 *
 * No cron expression support in core — keep the impl tiny. For cron, wrap
 * a cron parser (e.g. `croner`) and produce events on its schedule;
 * `examples/triggers/timer-with-cron.ts` shows the shape.
 *
 * Cancellation contract: `stop()` resolves immediately and aborts the
 * trigger's internal `AbortSignal`. Any in-flight payload factory that
 * accepts the signal can short-circuit. Even payloads that ignore the
 * signal don't block `stop()` — `makeEvent` races the payload promise
 * against the abort so `start()` returns promptly.
 */
import type { Trigger, TriggerEvent } from './types.js';
export interface TimerTriggerOptions<TInput = void> {
    /** Interval between fires, in milliseconds. */
    intervalMs: number;
    /**
     * Payload to attach to each event. Defaults to `undefined`. If a
     * function, called each fire to produce a fresh payload (e.g. the
     * current time, a counter, a snapshot from somewhere).
     *
     * Async factories receive the trigger's internal `AbortSignal` so they
     * may honor `stop()` cooperatively. The signature `(signal?) => ...`
     * keeps existing callers working unchanged.
     */
    payload?: TInput | ((signal?: AbortSignal) => TInput) | ((signal?: AbortSignal) => Promise<TInput>);
    /**
     * If true, fires immediately on `start()` before the first interval
     * elapses. Default: false (first event arrives after one interval).
     */
    fireImmediately?: boolean;
    /** Stable identifier used for logs. Default: `timer:${intervalMs}ms`. */
    name?: string;
}
export declare class TimerTrigger<TInput = void> implements Trigger<TInput> {
    readonly name: string;
    private readonly intervalMs;
    private readonly payload;
    private readonly fireImmediately;
    private seq;
    private stopped;
    private pendingTimer;
    private notifyStop;
    private readonly aborter;
    constructor(options: TimerTriggerOptions<TInput>);
    start(): AsyncGenerator<TriggerEvent<TInput>, void>;
    stop(): Promise<void>;
    private makeEventOrStop;
    private makeEvent;
    /** Returns true if the interval elapsed normally, false if stop() fired first. */
    private waitOrStop;
}
//# sourceMappingURL=timer-trigger.d.ts.map