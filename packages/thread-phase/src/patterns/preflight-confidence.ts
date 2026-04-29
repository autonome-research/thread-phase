/**
 * preflight-confidence — assess feasibility before spending big-model tokens.
 *
 * Run a fast, cheap check (often a metadata read or small LLM call) that
 * returns a typed score. The pipeline can either surface the score and
 * continue, or stop on insufficient signal.
 */

import type { BasePipelineContext, Phase } from '../phase.js';

export interface PreflightOptions<TCtx extends BasePipelineContext, TScore> {
  /** Compute the score. May be an LLM call, metadata read, or pure logic. */
  assess: (ctx: TCtx) => Promise<TScore>;
  /** Stash the score on ctx (typed by the caller's context type). */
  writeTo: (ctx: TCtx, score: TScore) => void;
  /** Optional: human-readable description appended as a `content` event. */
  describe?: (score: TScore) => string;
  /** Optional: return a non-null reason to halt the pipeline. */
  stopIf?: (score: TScore) => string | null;
}

export function preflightConfidence<TCtx extends BasePipelineContext, TScore>(
  phaseName: string,
  options: PreflightOptions<TCtx, TScore>,
): Phase<TCtx> {
  return {
    name: phaseName,
    async *run(ctx) {
      let score: TScore;
      try {
        score = await options.assess(ctx);
      } catch (err: unknown) {
        const e = err as { message?: string };
        yield {
          type: 'agent_activity',
          agent: phaseName,
          action: 'error',
          detail: e.message?.slice(0, 120),
        };
        return;
      }

      options.writeTo(ctx, score);

      yield { type: 'data', key: phaseName, value: score };

      if (options.describe) {
        yield { type: 'content', content: `${options.describe(score)}\n` };
      }

      const stopReason = options.stopIf?.(score);
      if (stopReason !== null && stopReason !== undefined) {
        ctx.stop = { reason: stopReason };
      }
    },
  };
}
