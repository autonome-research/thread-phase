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

import { runPipeline } from '../orchestrator.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../phase.js';
import { PipelineCache } from '../cache.js';

/**
 * The inner pipeline spec. Either a direct `{ phases, ctx }` object, or a
 * lazy resolver returning one (or `undefined` if not found). The CLI uses
 * the resolver form to look up registered pipelines by name without making
 * the core depend on the Registry.
 */
export type SubPipelineSource<TInnerCtx extends BasePipelineContext> =
  | { phases: ReadonlyArray<Phase<TInnerCtx>>; ctx: TInnerCtx }
  | (() => { phases: ReadonlyArray<Phase<TInnerCtx>>; ctx: TInnerCtx } | undefined);

export interface SubPipelineOptions<
  TOuterCtx extends BasePipelineContext,
  TInnerCtx extends BasePipelineContext,
> {
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
export function subPipeline<
  TOuterCtx extends BasePipelineContext,
  TInnerCtx extends BasePipelineContext,
>(
  name: string,
  options: SubPipelineOptions<TOuterCtx, TInnerCtx>,
): Phase<TOuterCtx> {
  return {
    name,
    async *run(outer) {
      const source =
        typeof options.pipeline === 'function'
          ? options.pipeline()
          : options.pipeline;
      if (!source) {
        throw new Error(
          `subPipeline "${name}": pipeline resolver returned undefined`,
        );
      }

      const inner = options.mapInput
        ? options.mapInput(outer)
        : source.ctx;

      // Isolate the inner pipeline's cache; propagate the outer's signal.
      (inner as { cache: PipelineCache }).cache = new PipelineCache();
      inner.signal = outer.signal;

      yield* runPipeline(source.phases, inner) as AsyncGenerator<
        PipelineEvent,
        void
      >;

      options.mapOutput?.(outer, inner);
    },
  };
}

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
export function subPipelineOf<
  TInnerCtx extends BasePipelineContext,
  TOuterCtx extends BasePipelineContext = BasePipelineContext,
>(
  name: string,
  source: { phases: ReadonlyArray<Phase<TInnerCtx>>; ctx: TInnerCtx },
  mapping?: Omit<SubPipelineOptions<TOuterCtx, TInnerCtx>, 'pipeline'>,
): Phase<TOuterCtx> {
  return subPipeline<TOuterCtx, TInnerCtx>(name, {
    pipeline: source,
    ...mapping,
  });
}

/**
 * Imperative form: invoke an inner pipeline from inside a phase body.
 * Returns the inner ctx (post-run) and the pipeline summary. Phase
 * exceptions in the inner pipeline propagate as rejections.
 */
export async function runSubPipeline<
  TInnerCtx extends BasePipelineContext,
>(
  source: SubPipelineSource<TInnerCtx>,
  options: {
    /** Optional outer signal to propagate into the inner pipeline's ctx. */
    signal?: AbortSignal;
    /** Optional override of the inner ctx (otherwise source's ctx is used). */
    ctx?: TInnerCtx;
  } = {},
): Promise<{ ctx: TInnerCtx; summary: { status: 'completed' | 'stopped'; reason?: string; eventCount: number } }> {
  const resolved =
    typeof source === 'function' ? source() : source;
  if (!resolved) {
    throw new Error('runSubPipeline: pipeline resolver returned undefined');
  }

  const inner = options.ctx ?? resolved.ctx;
  (inner as { cache: PipelineCache }).cache = new PipelineCache();
  if (options.signal) inner.signal = options.signal;

  let eventCount = 0;
  let stopReason: string | undefined;

  for await (const event of runPipeline(resolved.phases, inner)) {
    eventCount++;
    if (event.type === 'done') {
      stopReason = (event as { reason?: string }).reason;
    }
  }

  return {
    ctx: inner,
    summary:
      stopReason !== undefined
        ? { status: 'stopped', reason: stopReason, eventCount }
        : { status: 'completed', eventCount },
  };
}
