/**
 * Trigger protocol — the entry-point abstraction.
 *
 * A `Trigger` is a signal source that yields typed events. A consumer
 * (typically `runTrigger`) reads the generator and dispatches a pipeline
 * for each event. Triggers do not know about pipelines, ctx, or the
 * JobStore — they only know about producing events.
 *
 * Concrete impls in this package: `TimerTrigger`. Anything else
 * (HTTP webhooks, queue consumers, file watchers, message brokers)
 * lives outside core. The `examples/triggers/` tree shows how to
 * adapt arbitrary signal sources into this interface.
 *
 * Design properties:
 *   - The generator yields forever until `stop()` resolves or the
 *     underlying source exhausts.
 *   - `stop()` returns a promise so resource cleanup (closing servers,
 *     clearing timers, draining buffers) can be awaited.
 *   - Each event carries an `id` monotonic within the trigger instance
 *     so consumers can deduplicate or correlate without a separate seq.
 */
/**
 * One event produced by a trigger.
 *
 * `input` is the structured payload the pipeline factory will consume.
 * `metadata` is for transport-level info (HTTP headers, source IP,
 * queue message id, file path) that the pipeline may want for logging
 * or auditing but doesn't shape the work.
 */
export interface TriggerEvent<TInput = unknown> {
    /** Monotonically increasing id within this trigger instance, starting at 1. */
    readonly id: number;
    /** ISO timestamp at the moment the trigger observed the event. */
    readonly occurredAt: string;
    /** Structured payload. Pipeline factory consumes this. */
    readonly input: TInput;
    /** Transport-level info: headers, source IP, message id, file path, etc. */
    readonly metadata?: Readonly<Record<string, unknown>>;
}
/**
 * A signal source that fires pipelines.
 *
 * `start()` returns an async generator yielding events. The consumer
 * controls pacing — back-pressure is the consumer's responsibility.
 *
 * `stop()` must idempotently clean up resources. After `stop()` resolves,
 * the generator returned by `start()` must complete (no more yields).
 *
 * Implementations are single-consumer. To fan one trigger's events out
 * to multiple consumers, build the multiplexer in user code — keeping
 * the protocol single-consumer keeps shutdown semantics simple.
 */
export interface Trigger<TInput = unknown> {
    /** Stable identifier used for logs and error messages. */
    readonly name: string;
    /** Async iterable of events. Yields until `stop()` resolves. */
    start(): AsyncGenerator<TriggerEvent<TInput>, void>;
    /** Release resources. Idempotent. */
    stop(): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map