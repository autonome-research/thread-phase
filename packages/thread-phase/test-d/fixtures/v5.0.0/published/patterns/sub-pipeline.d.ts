/**
 * subPipeline — compose a registered (or inline) pipeline as a phase
 * inside another pipeline.
 *
 * Two surface forms:
 *
 *   - **`subPipeline(name, options)`** — higher-order pattern returning a
 *     `Phase<TOuterCtx>`. Compose like any other phase.
 *   - **`runSubPipeline(spec, options)`** — free function for imperative
 *     use inside phase bodies. Returns `{ ctx, summary }`.
 *
 * The inner pipeline gets:
 *   - a fresh `PipelineCache` (cache scopes are isolated)
 *   - the outer ctx's `signal` (cancellation propagates down)
 *
 * Events from the inner pipeline flatten into the outer event stream
 * via `yield*` — JobStore consumers, SSE listeners, and the orchestrator
 * see one continuous stream.
 */
import type { BasePipelineContext, Phase } from '../phase.js';
/**
 * The inner pipeline spec. Either a direct `{ phases, ctx }` object, or a
 * lazy resolver returning one (or `undefined` if not found). The CLI uses
 * the resolver form to look up registered pipelines by name without making
 * the core depend on the Registry.
 */
export type SubPipelineSource<TInnerCtx extends BasePipelineContext> = {
    phases: ReadonlyArray<Phase<TInnerCtx>>;
    ctx: TInnerCtx;
} | (() => {
    phases: ReadonlyArray<Phase<TInnerCtx>>;
    ctx: TInnerCtx;
} | undefined);
export interface SubPipelineOptions<TOuterCtx extends BasePipelineContext, TInnerCtx extends BasePipelineContext> {
    /** Inner pipeline source: direct object or lazy resolver. */
    pipeline: SubPipelineSource<TInnerCtx>;
    /**
     * Map outer ctx to the inner pipeline's starting ctx. Optional — if
     * omitted, the inner pipeline starts with its own ctx as supplied by the
     * source (the outer's `signal` is still wired in either way).
     */
    mapInput?: (outer: TOuterCtx) => TInnerCtx;
    /**
     * Merge the inner pipeline's terminal state back into outer ctx. Optional
     * — if omitted, the inner's outputs are discarded.
     */
    mapOutput?: (outer: TOuterCtx, inner: TInnerCtx) => void;
}
/** A higher-order pattern returning a `Phase<TOuterCtx>`. */
export declare function subPipeline<TOuterCtx extends BasePipelineContext, TInnerCtx extends BasePipelineContext>(name: string, options: SubPipelineOptions<TOuterCtx, TInnerCtx>): Phase<TOuterCtx>;
/**
 * Type-inferred convenience over `subPipeline` for the direct-object case.
 * `TInnerCtx` is inferred from `source.ctx`, so callers only spell the outer
 * ctx generic (and often not even that):
 *
 *   subPipelineOf('inner', innerSpec, { mapOutput: ... })
 *
 * vs. the more verbose `subPipeline<MyOuter, MyInner>(...)`. For the lazy
 * registry-lookup case, use `subPipeline` directly — the resolver form needs
 * explicit generics anyway.
 */
export declare function subPipelineOf<TInnerCtx extends BasePipelineContext, TOuterCtx extends BasePipelineContext = BasePipelineContext>(name: string, source: {
    phases: ReadonlyArray<Phase<TInnerCtx>>;
    ctx: TInnerCtx;
}, mapping?: Omit<SubPipelineOptions<TOuterCtx, TInnerCtx>, 'pipeline'>): Phase<TOuterCtx>;
/**
 * Imperative form: invoke an inner pipeline from inside a phase body.
 * Returns the inner ctx (post-run) and the pipeline summary. Phase
 * exceptions in the inner pipeline propagate as rejections.
 */
export declare function runSubPipeline<TInnerCtx extends BasePipelineContext>(source: SubPipelineSource<TInnerCtx>, options?: {
    /** Optional outer signal to propagate into the inner pipeline's ctx. */
    signal?: AbortSignal;
    /** Optional override of the inner ctx (otherwise source's ctx is used). */
    ctx?: TInnerCtx;
}): Promise<{
    ctx: TInnerCtx;
    summary: {
        status: 'completed' | 'stopped';
        reason?: string;
        eventCount: number;
    };
}>;
//# sourceMappingURL=sub-pipeline.d.ts.map