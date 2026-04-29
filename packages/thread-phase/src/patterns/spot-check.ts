/**
 * spot-check — verify a sample of typed claims from a prior phase.
 *
 * Pattern: extract a list of claims from an upstream artifact (synthesis,
 * report, draft), verify a capped subset in parallel, stash the results.
 */

import type { BasePipelineContext, Phase } from '../phase.js';
import { parallelFanout } from './parallel-fanout.js';

export interface SpotCheckOptions<TCtx extends BasePipelineContext, TClaim, TResult> {
  /** Pull the candidate claims from ctx (typically off a prior phase's output). */
  extractClaims: (ctx: TCtx) => TClaim[];
  /** Verify a single claim. Often runs an agent with read-only tools. */
  verify: (claim: TClaim, ctx: TCtx) => Promise<TResult>;
  /** Stash results on ctx. */
  writeTo: (ctx: TCtx, results: TResult[]) => void;
  /** Cap concurrent verifications. Default 5. */
  maxClaims?: number;
}

export function spotCheck<TCtx extends BasePipelineContext, TClaim, TResult>(
  phaseName: string,
  options: SpotCheckOptions<TCtx, TClaim, TResult>,
): Phase<TCtx> {
  return {
    name: phaseName,
    async *run(ctx) {
      const allClaims = options.extractClaims(ctx);
      const max = options.maxClaims ?? 5;
      const claims = allClaims.slice(0, max);

      yield {
        type: 'phase',
        phase: phaseName,
        detail: `Verifying ${claims.length}/${allClaims.length} claim(s)`,
        counts: { claims: claims.length, total: allClaims.length },
      };

      if (claims.length === 0) {
        options.writeTo(ctx, []);
        return;
      }

      const results = await parallelFanout({
        items: claims,
        runner: (claim) => options.verify(claim, ctx),
      });

      options.writeTo(ctx, results);
    },
  };
}
