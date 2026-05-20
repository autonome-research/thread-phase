/**
 * Backward-compat shim — the agent runner was split into focused modules
 * under `./agent/`. This file re-exports the same public surface so existing
 * imports continue to work.
 *
 * For new code, import from `thread-phase` (or directly from `./agent/*`)
 * rather than this path.
 */

export {
  runAgentWithTools,
  parseJSON,
  type AgentConfig,
  type ActivityEntry,
  type AgentRunResult,
  type AgentRunnerOptions,
  type AgentStreamEvent,
  type FinishReason,
  type UsageInfo,
} from './agent/index.js';
