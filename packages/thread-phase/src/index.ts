/**
 * Public API — the v1 stable surface.
 *
 * Everything exported from this file is covered by semver:
 *   - patch (1.0.x): bug fixes, no API changes
 *   - minor (1.x.0): additive only — new exports, new optional fields
 *   - major (x.0.0): breaking changes
 *
 * Items marked @internal in their own files (e.g. `consumeStream`,
 * `toOpenAIMessages`) are reachable via deep import for advanced callers
 * but are NOT part of this stable surface and may change in minor releases.
 *
 * Subpath exports (./patterns, ./context, ./session, ./tools) live in their
 * own index files and are exposed via package.json `exports`. They follow
 * the same stability policy.
 */

// Phase framework
export { PipelineCache } from './cache.js';
export {
  runPipeline,
  runPipelineToSummary,
  completedCheckpointsFromEvents,
  type PipelineSummary,
  type RunPipelineOptions,
} from './orchestrator.js';
export {
  requireCtx,
  type Phase,
  type BasePipelineContext,
  type PipelineEvent,
} from './phase.js';

// Internal Message shape — closer to OpenAI than Anthropic. Exported so
// downstream code can construct conversation history and tool definitions
// without owning the wire-format translation.
export {
  type Message,
  type SystemMessage,
  type UserMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
  type ToolExecutor,
} from './messages.js';

// Inference — convenience builders for an OpenAI-compatible client.
export {
  loadInferenceConfig,
  createInferenceClient,
  type InferenceConfig,
} from './inference.js';

// Agent runner — the iterated tool-use loop primitive.
export {
  runAgentWithTools,
  parseJSON,
  parseJSONStrict,
  type AgentConfig,
  type AgentRunnerOptions,
  type AgentRunResult,
  type ActivityEntry,
  type AgentStreamEvent,
  type FinishReason,
  type UsageInfo,
} from './agent/index.js';

// Session — persisted event log + job runner. SqliteJobStore is the
// bundled default; JobStore is the async interface — bring your own backend
// if needed. SqliteJobStore wraps its synchronous hot path in async methods so
// local and network-backed stores share one consistency contract.
export {
  type JobStore,
  JobOwnershipLostError,
  SqliteJobStore,
  JobRunner,
  type JobRecord,
  type EventRecord,
  type JobFinalization,
  type JobStatus,
  type JobOwnership,
  type ListJobsOptions,
  type GetJobOptions,
  type JobRunnerOptions,
  type JobRunOptions,
  type JobRunDrain,
  type JobRunHandle,
  type LiveEvent,
} from './session/index.js';

// Tools — registry with optional ajv arg validation. Implements
// ToolExecutor so it can be passed directly to runAgentWithTools.
export {
  ToolRegistry,
  type ToolHandler,
  type ToolRegistryOptions,
} from './tools/index.js';

// Helpers — one-call wrappers for the common Trigger + Pipeline shapes.
// Each returns an `ExtensionRegisterFn` `(api) => void` consumable by the
// CLI auto-loader.
export {
  oneShot,
  schedule,
  hook,
  CronTrigger,
  HttpTrigger,
  HookValidationError,
  type OneShotOptions,
  type ScheduleSpec,
  type ScheduleOptions,
  type HookSpec,
  type HookOptions,
  type ExtensionRegisterFn,
  type HelperHandler,
  type PipelineSpec,
  type ThreadPhaseAPI,
} from './helpers/index.js';
