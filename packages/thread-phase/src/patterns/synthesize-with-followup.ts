/**
 * synthesize-with-followup — synthesizer reviews its own output and may
 * request another round of upstream work.
 *
 * Loop:
 *   1. Synthesizer produces draft text (typically streaming).
 *   2. extractFollowUp inspects the draft for explicit "I need more on X".
 *   3. If present and budget allows, doFollowUp runs whatever upstream phases
 *      need to re-run, then we loop.
 *   4. Otherwise the loop exits and the final text is written to ctx.
 */

import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';

export interface SynthesizeWithFollowupOptions<TCtx extends BasePipelineContext, TFollowUp> {
  /**
   * Run the synthesizer. May yield events (typically streamed `content`).
   * Returns the final text via the generator's return value.
   */
  synthesize: (ctx: TCtx, iteration: number) => AsyncGenerator<PipelineEvent, string, void>;
  /**
   * Inspect the synthesizer output. Return null if synthesis is complete,
   * or a typed follow-up directive if more work is needed.
   */
  extractFollowUp: (output: string) => TFollowUp | null;
  /**
   * Run whatever extra work the follow-up requested (often re-runs of
   * upstream phases). May yield events.
   */
  doFollowUp: (ctx: TCtx, followUp: TFollowUp, iteration: number) => AsyncGenerator<PipelineEvent, void, void>;
  /** Stash the final synthesized text on ctx. */
  writeTo: (ctx: TCtx, text: string) => void;
  /** Cap iterations. Default 2 (one synthesis + one follow-up). */
  maxIterations?: number;
}

export function synthesizeWithFollowup<TCtx extends BasePipelineContext, TFollowUp>(
  phaseName: string,
  options: SynthesizeWithFollowupOptions<TCtx, TFollowUp>,
): Phase<TCtx> {
  return {
    name: phaseName,
    async *run(ctx) {
      const max = options.maxIterations ?? 2;
      let finalText = '';

      for (let iter = 0; iter < max; iter++) {
        const synthGen = options.synthesize(ctx, iter);
        let stepText = '';
        while (true) {
          const next = await synthGen.next();
          if (next.done) {
            stepText = next.value;
            break;
          }
          yield next.value;
        }
        finalText = stepText;

        const followUp = options.extractFollowUp(stepText);
        if (!followUp || iter === max - 1) break;

        yield {
          type: 'agent_activity',
          agent: phaseName,
          action: 'follow_up',
          detail: `iteration ${iter + 1} requested more work`,
        };
        yield* options.doFollowUp(ctx, followUp, iter);
      }

      options.writeTo(ctx, finalText);
    },
  };
}
