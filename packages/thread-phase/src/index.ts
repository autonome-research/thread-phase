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
export { runPipeline } from './orchestrator.js';
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
  type AgentConfig,
  type AgentRunnerOptions,
  type AgentRunResult,
  type ActivityEntry,
  type AgentStreamEvent,
  type FinishReason,
  type UsageInfo,
} from './agent/index.js';

// Session — persisted event log + job runner. SqliteJobStore is the
// bundled default; JobStore is the interface — bring your own backend if
// needed. The interface is sync by deliberate choice for v1 (sqlite hot
// path); see ROADMAP for the rationale.
export {
  type JobStore,
  SqliteJobStore,
  JobRunner,
  type JobRecord,
  type EventRecord,
  type JobStatus,
  type ListJobsOptions,
  type LiveEvent,
} from './session/index.js';

// Tools — registry with optional ajv arg validation. Implements
// ToolExecutor so it can be passed directly to runAgentWithTools.
export {
  ToolRegistry,
  type ToolHandler,
  type ToolRegistryOptions,
} from './tools/index.js';
