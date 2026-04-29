/**
 * Reusable phase patterns. Each pattern is a small, opinionated helper that
 * captures a recurring shape — not a black-box framework. Compose freely.
 */

export {
  parallelFanout,
  type FanOutOptions,
} from './parallel-fanout.js';

export {
  boundedFanout,
  type BoundedFanOutOptions,
  type ItemDoneEvent,
} from './bounded-fanout.js';

export {
  intentGate,
  type IntentClassification,
  type IntentDecision,
  type IntentGateOptions,
} from './intent-gate.js';

export {
  preflightConfidence,
  type PreflightOptions,
} from './preflight-confidence.js';

export {
  synthesizeWithFollowup,
  type SynthesizeWithFollowupOptions,
} from './synthesize-with-followup.js';

export {
  spotCheck,
  type SpotCheckOptions,
} from './spot-check.js';
