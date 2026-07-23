/**
 * Reusable phase patterns. Each pattern is a small, opinionated helper that
 * captures a recurring shape — not a black-box framework. Compose freely.
 *
 * # API convention
 *
 * Patterns in this barrel use ONE of two signature shapes — pick the one
 * that matches what the pattern returns:
 *
 *   - Pattern factories: (name: string, options) => Phase<TCtx>
 *       parallelPhases, intentGate, match, whileCondition, subPipeline.
 *       Use when you return a Phase. The `name` survives into telemetry
 *       and event metadata.
 *
 *   - Eager runners: (options) => Promise<T>
 *       boundedFanout, boundedFanoutOf.
 *       Use when the function executes immediately and returns a Promise.
 *       No `name` because there's no Phase identity to attach.
 *
 * `withRetry` is a Phase WRAPPER — (innerPhase, options) => Phase<TCtx> —
 * a minor variant of the factory shape that takes the wrapped phase first.
 *
 * Registration helpers (oneShot/schedule/hook in ../helpers) form a third
 * category with their own convention. See AGENTS.md "API conventions —
 * three factory shapes" for the full rationale.
 */
export { parallelPhases } from './parallel-phases.js';
export { boundedFanout, type BoundedFanOutOptions, type ItemDoneEvent, type ItemErrorEvent, type FanOutResult, } from './bounded-fanout.js';
export { boundedFanoutOf, BoundedFanoutOfError } from './bounded-fanout-of.js';
export type { BoundedFanoutOfOptions, BoundedFanoutOfMode } from './bounded-fanout-of.js';
export { intentGate, type IntentClassification, type IntentDecision, type IntentGateOptions, } from './intent-gate.js';
export { whileCondition, type WhileConditionOptions, } from './while-condition.js';
export { match, type MatchOptions, } from './match.js';
export { withRetry, type WithRetryOptions, } from './with-retry.js';
export { subPipeline, subPipelineOf, runSubPipeline, type SubPipelineOptions, type SubPipelineSource, } from './sub-pipeline.js';
//# sourceMappingURL=index.d.ts.map