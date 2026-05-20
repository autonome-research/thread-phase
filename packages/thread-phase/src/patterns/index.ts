/**
 * Reusable phase patterns. Each pattern is a small, opinionated helper that
 * captures a recurring shape — not a black-box framework. Compose freely.
 */

export { parallelPhases } from './parallel-phases.js';

export {
  boundedFanout,
  type BoundedFanOutOptions,
  type ItemDoneEvent,
  type ItemErrorEvent,
  type FanOutResult,
} from './bounded-fanout.js';

export { boundedFanoutOf, BoundedFanoutOfError } from './bounded-fanout-of.js';
export type { BoundedFanoutOfOptions, BoundedFanoutOfMode } from './bounded-fanout-of.js';

export {
  intentGate,
  type IntentClassification,
  type IntentDecision,
  type IntentGateOptions,
} from './intent-gate.js';

export {
  whileCondition,
  type WhileConditionOptions,
} from './while-condition.js';

export {
  match,
  type MatchOptions,
} from './match.js';

export {
  withRetry,
  type WithRetryOptions,
} from './with-retry.js';

export {
  subPipeline,
  subPipelineOf,
  runSubPipeline,
  type SubPipelineOptions,
  type SubPipelineSource,
} from './sub-pipeline.js';
