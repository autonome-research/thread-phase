/**
 * Agent module barrel.
 *
 * The split is internal: external imports continue to use
 * `from 'thread-phase'` (re-exported from src/index.ts) — this barrel just
 * defines the agent module's surface for code that wants to dive in
 * deliberately.
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

// Lower-level pieces — exported so advanced callers (and tests) can use
// them directly without having to vendor copies. Most users won't need
// these.
export { toOpenAIMessages, toOpenAITools } from './openai-adapter.js';
export {
  consumeStream,
  looksLikeToolCallText,
  normalizeFinishReason,
  type AccumulatedRound,
} from './stream-consumer.js';
export { isRetryableError, isAbortError } from './retry.js';
