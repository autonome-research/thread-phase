/**
 * intent-gate — classify the input cheaply, route to a fast path or continue.
 *
 * Common cost-control pattern: a 1-call cheap classifier decides whether the
 * pipeline should run end-to-end (`continue`) or short-circuit to a much
 * cheaper handler (e.g. a one-shot direct answer). The handler may produce
 * its own output before the pipeline halts.
 */

import type { BasePipelineContext, Phase, PipelineEvent } from '../phase.js';

export interface IntentClassification<TIntent extends string> {
  intent: TIntent;
  /** Optional rationale surfaced in the activity log. */
  rationale?: string;
}

export type IntentDecision<TCtx extends BasePipelineContext> =
  | 'continue'
  | {
      stop: string;
      /** Optional generator that yields events before the pipeline halts. */
      handler?: (ctx: TCtx) => AsyncGenerator<PipelineEvent, void, void>;
    };

export interface IntentGateOptions<TCtx extends BasePipelineContext, TIntent extends string> {
  /** Run the classifier (typically a cheap LLM call). */
  classify: (ctx: TCtx) => Promise<IntentClassification<TIntent>>;
  /** Map a classified intent to either 'continue' or a stop directive. */
  route: (intent: TIntent, ctx: TCtx) => IntentDecision<TCtx>;
}

export function intentGate<TCtx extends BasePipelineContext, TIntent extends string>(
  phaseName: string,
  options: IntentGateOptions<TCtx, TIntent>,
): Phase<TCtx> {
  return {
    name: phaseName,
    async *run(ctx) {
      const classification = await options.classify(ctx);
      yield {
        type: 'agent_activity',
        agent: phaseName,
        action: 'classified',
        detail: classification.rationale
          ? `${classification.intent} — ${classification.rationale}`
          : classification.intent,
      };

      const decision = options.route(classification.intent, ctx);
      if (decision === 'continue') return;

      if (decision.handler) {
        yield* decision.handler(ctx);
      }
      ctx.stop = { reason: decision.stop };
    },
  };
}
