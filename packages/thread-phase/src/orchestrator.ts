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

export async function* runPipeline<
  TCtx extends BasePipelineContext,
  TEvent = PipelineEvent,
>(
  phases: ReadonlyArray<Phase<TCtx, TEvent>>,
  ctx: TCtx,
): AsyncGenerator<TEvent, void> {
  try {
    for (const phase of phases) {
      yield* phase.run(ctx);
      if (ctx.stop) {
        yield { type: 'done', reason: ctx.stop.reason } as unknown as TEvent;
        return;
      }
    }
    yield { type: 'done' } as unknown as TEvent;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message } as unknown as TEvent;
  } finally {
    ctx.cache.clear();
  }
}
