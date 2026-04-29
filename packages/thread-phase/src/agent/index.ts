/**
 * Agent module barrel.
 *
 * Two tiers of exports:
 *
 *   1. Stable (covered by semver, won't break in minor/patch releases):
 *      `runAgentWithTools`, `parseJSON`, and the type surface
 *      (`AgentConfig`, `AgentRunResult`, `AgentRunnerOptions`,
 *      `AgentStreamEvent`, `FinishReason`, `UsageInfo`, `ActivityEntry`).
 *
 *   2. @internal (exported for advanced callers, NOT covered by semver):
 *      `consumeStream`, `looksLikeToolCallText`, `normalizeFinishReason`,
 *      `AccumulatedRound`, `toOpenAIMessages`, `toOpenAITools`,
 *      `isRetryableError`, `isAbortError`. These exist so callers building
 *      their own non-loop flows can reuse the building blocks; if you do,
 *      pin the minor version and read the CHANGELOG before upgrading.
 *
 * The package's main `src/index.ts` re-exports only the stable surface —
 * @internal items are reachable only via deep import (`thread-phase/agent`
 * is intentionally NOT a configured package subpath).
 */

export { runAgentWithTools } from './runner.js';
export { parseJSON } from './parse-json.js';

export type {
  AgentConfig,
  ActivityEntry,
  AgentRunResult,
  AgentRunnerOptions,
  AgentStreamEvent,
  FinishReason,
  UsageInfo,
} from './types.js';

// @internal — see file header. Lower-level pieces for advanced callers.
export { toOpenAIMessages, toOpenAITools } from './openai-adapter.js';
export {
  consumeStream,
  looksLikeToolCallText,
  normalizeFinishReason,
  type AccumulatedRound,
} from './stream-consumer.js';
export { isRetryableError, isAbortError } from './retry.js';
