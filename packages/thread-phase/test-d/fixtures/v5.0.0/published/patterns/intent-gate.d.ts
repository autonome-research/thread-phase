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
export type IntentDecision<TCtx extends BasePipelineContext> = 'continue' | {
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
export declare function intentGate<TCtx extends BasePipelineContext, TIntent extends string>(phaseName: string, options: IntentGateOptions<TCtx, TIntent>): Phase<TCtx>;
//# sourceMappingURL=intent-gate.d.ts.map