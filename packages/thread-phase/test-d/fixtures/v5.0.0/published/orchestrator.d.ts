/**
 * Pipeline orchestrator — runs a list of phases over a shared context.
 *
 * Owns the canonical terminal events (`done` / `error`) so phases never have
 * to emit them themselves. Halts the pipeline cleanly when any phase sets
 * `ctx.stop`.
 *
 * Composition is just an array of phases. Reorder by reordering the array.
 * Add a phase by including a new entry. No DAG framework, no plugin system.
 *
 * Generic over the phases' event type. Downstream apps that parameterize
 * Phase with a custom TEvent get the same TEvent surfaced through the
 * orchestrator's stream — but TEvent must be assignable from the
 * framework's `done`/`error` shapes (see PipelineEvent), so the simplest
 * downstream pattern is `type MyEvent = PipelineEvent | { type: 'mine' };`.
 */
import type { BasePipelineContext, Phase, PipelineEvent } from './phase.js';
/**
 * The terminal state of a pipeline run.
 *
 * - `completed` — all phases ran to completion.
 * - `stopped` — a phase set `ctx.stop`; pipeline halted cleanly with that reason.
 *
 * Phase exceptions do not produce a summary; they propagate to the caller.
 * Use `runPipelineToSummary` to wrap the generator and convert throws into
 * promise rejections (with the original error preserved).
 */
export interface PipelineSummary {
    readonly status: 'completed' | 'stopped';
    /** Present iff `status === 'stopped'`. The `ctx.stop.reason` value. */
    readonly reason?: string;
    /** Total events yielded, including the terminal `done` event. */
    readonly eventCount: number;
}
export interface RunPipelineOptions {
    /**
     * AbortSignal observed between phases. If the signal aborts at any point,
     * `runPipeline` throws an `AbortError` (`name === 'AbortError'`) before
     * the next phase runs. Phases that want mid-phase cancellation should
     * observe the signal themselves and unwind cleanly.
     */
    signal?: AbortSignal;
    /**
     * Resume-from-checkpoint option. When provided, phases whose
     * `checkpointKey` appears in `completedKeys` are SKIPPED — their
     * `run(ctx)` is not invoked, no `phase_complete` event is re-emitted.
     * Phases without a `checkpointKey` always run.
     *
     * Derive `completedKeys` from a prior run's event log via
     * `completedCheckpointsFromEvents`.
     *
     * Resume restores ORCHESTRATOR POSITION ONLY. It does not restore the
     * cache, `ctx.stop`, thread state, memory, or any caller-defined ctx
     * fields. The caller is responsible for rebuilding ctx into a state
     * the skipped phases would have left it in.
     */
    resume?: {
        completedKeys: ReadonlySet<string>;
    };
}
/**
 * Derive the set of completed `checkpointKey` values from an iterable
 * of `PipelineEvent`s. Use to translate a prior run's event log into
 * `RunPipelineOptions.resume.completedKeys`.
 *
 *   const events = await store.getEvents(prevJobId);
 *   const completedKeys = completedCheckpointsFromEvents(events.map(e => e.data));
 *   await runPipeline(phases, freshCtx, { resume: { completedKeys } });
 */
export declare function completedCheckpointsFromEvents(events: Iterable<PipelineEvent>): Set<string>;
export declare function runPipeline<TCtx extends BasePipelineContext, TEvent = PipelineEvent>(phases: ReadonlyArray<Phase<TCtx, TEvent>>, ctx: TCtx, options?: RunPipelineOptions): AsyncGenerator<TEvent | PipelineEvent, void>;
/**
 * Consume `runPipeline` to completion and return a typed summary.
 *
 * On success, resolves with `{ status, reason?, eventCount }`. Phase
 * exceptions reject the promise with the original error (the cache is
 * still cleared via the generator's `finally`).
 *
 * Use this when you want a single `await` for the whole pipeline rather
 * than iterating events yourself.
 */
export declare function runPipelineToSummary<TCtx extends BasePipelineContext, TEvent extends PipelineEvent = PipelineEvent>(phases: ReadonlyArray<Phase<TCtx, TEvent>>, ctx: TCtx, options?: RunPipelineOptions): Promise<PipelineSummary>;
//# sourceMappingURL=orchestrator.d.ts.map