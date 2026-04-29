/**
 * Pipeline orchestrator — runs a list of phases over a shared context.
 *
 * Owns the canonical terminal events (`done` / `error`) so phases never have
 * to emit them themselves. Halts the pipeline cleanly when any phase sets
 * `ctx.stop`.
 *
 * Composition is just an array of phases. Reorder by reordering the array.
 * Add a phase by including a new entry. No DAG framework, no plugin system.
 */

import type { BasePipelineContext, Phase, PipelineEvent } from './phase.js';

export async function* runPipeline<TCtx extends BasePipelineContext>(
  phases: ReadonlyArray<Phase<TCtx>>,
  ctx: TCtx,
): AsyncGenerator<PipelineEvent, void> {
  try {
    for (const phase of phases) {
      yield* phase.run(ctx);
      if (ctx.stop) {
        yield { type: 'done', reason: ctx.stop.reason };
        return;
      }
    }
    yield { type: 'done' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message };
  } finally {
    ctx.cache.clear();
  }
}
