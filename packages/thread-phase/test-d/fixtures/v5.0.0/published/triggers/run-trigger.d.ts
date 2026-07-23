/**
 * runTrigger — the canonical Trigger consumer.
 *
 * Reads events from a `Trigger`, calls a user-supplied factory to produce
 * `{ phases, ctx }` per event, and dispatches each pipeline. If a
 * `JobRunner` is supplied, dispatch is persisted (job rows, event log,
 * cancellation); otherwise the pipeline runs inline via
 * `runPipelineToSummary` and events are discarded after dispatch.
 *
 * Resolves when the trigger generator exhausts, the abort signal fires,
 * or `stop()` is called via the returned handle.
 *
 * Concurrency cap is a blocking semaphore. When `maxConcurrency` pipelines
 * are in flight, the loop awaits a slot before pulling the next event
 * from the trigger. The trigger's generator naturally pauses production
 * — no events are dropped, no unbounded queue grows.
 *
 * Pipeline failures are isolated — one failing pipeline does not stop
 * the trigger loop. Errors go through `onError` (or default stderr log)
 * and the next event is still dispatched.
 *
 * Cancellation: each in-flight dispatch owns an `AbortController`. Call
 * `handle.cancel(triggerEventId)` to abort that specific pipeline; the
 * signal flows into `runPipelineToSummary` (inline) or `jobRunner.cancel`
 * (persisted). Returns `true` if the pipeline was found and aborted,
 * `false` if the event id is unknown or already completed.
 *
 * Observability: `onCapacityFull(event)` fires when an event arrives
 * while the concurrency cap is full (the loop blocks on `Promise.race`
 * before pulling the event, so this is the moment backpressure starts).
 * `onDispatchStart(event)` fires immediately when a dispatch begins,
 * before the user-supplied factory runs.
 */
import type { JobRunner } from '../session/index.js';
import type { BasePipelineContext, Phase } from '../phase.js';
import type { Trigger, TriggerEvent } from './types.js';
export interface RunTriggerOptions<TInput, TCtx extends BasePipelineContext> {
    /**
     * Optional JobRunner. If provided, each event creates a persisted job
     * row and pipelines run through `runner.run()` (events go to the
     * event log, cancellation works via `runner.cancel(jobId)`). If
     * omitted, pipelines run inline.
     */
    jobRunner?: JobRunner;
    /** Name used for job rows when `jobRunner` is set. Default: `trigger.name`. */
    pipelineName?: string;
    /**
     * Maximum concurrent in-flight pipelines from this trigger. When the
     * cap is reached, the loop blocks before pulling the next event
     * (backpressure flows back to the trigger). Default: 1.
     */
    maxConcurrency?: number;
    /** Abort the run loop and call `trigger.stop()`. Outstanding pipelines complete. */
    signal?: AbortSignal;
    /** Called when a pipeline is about to start, after dispatch picks it up. */
    onStart?: (event: TriggerEvent<TInput>, jobId?: string) => void;
    /** Called when a pipeline completes successfully. */
    onComplete?: (event: TriggerEvent<TInput>, jobId?: string) => void;
    /** Called when a pipeline throws. Default: log to stderr. */
    onError?: (event: TriggerEvent<TInput>, error: Error, jobId?: string) => void;
    /**
     * Called when an event arrives while the concurrency cap is full —
     * the moment backpressure begins. The dispatch still happens once a
     * slot frees; this hook only signals the wait.
     */
    onCapacityFull?: (event: TriggerEvent<TInput>) => void;
    /** Called the moment dispatch starts, before the pipeline factory runs. */
    onDispatchStart?: (event: TriggerEvent<TInput>) => void;
}
export interface RunTriggerHandle {
    /** Resolves when the run loop has exited (trigger exhausted, signal fired, or `stop()` called). */
    done: Promise<void>;
    /** Stop the trigger and resolve `done` once outstanding pipelines complete. */
    stop(): Promise<void>;
    /**
     * Abort a specific in-flight pipeline by its trigger event id. Returns
     * `true` if the pipeline was found and cancellation was initiated;
     * `false` if the event id is unknown or already completed.
     */
    cancel(triggerEventId: number): boolean;
}
export declare function runTrigger<TInput, TCtx extends BasePipelineContext>(trigger: Trigger<TInput>, pipelineFactory: (input: TInput, event: TriggerEvent<TInput>) => {
    phases: ReadonlyArray<Phase<TCtx>>;
    ctx: TCtx;
}, options?: RunTriggerOptions<TInput, TCtx>): RunTriggerHandle;
//# sourceMappingURL=run-trigger.d.ts.map