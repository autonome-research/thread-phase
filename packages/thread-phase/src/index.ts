// Public API.
//
// Subpath exports (./patterns, ./context, ./session, ./tools) live in their
// own index files and are exposed via package.json `exports`.

// Phase framework
export { PipelineCache } from './cache.js';
export { runPipeline } from './orchestrator.js';
export {
  requireCtx,
  type Phase,
  type BasePipelineContext,
  type PipelineEvent,
} from './phase.js';

// Messages and tool definitions (internal shape)
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

// Inference
export {
  loadInferenceConfig,
  createInferenceClient,
  type InferenceConfig,
} from './inference.js';

// Agent runner
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

// Session: persisted event log + job runner (sqlite is the bundled default,
// JobStore is the interface — bring your own backend if needed).
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

// Tools: registry + arg validation
export {
  ToolRegistry,
  type ToolHandler,
  type ToolRegistryOptions,
} from './tools/index.js';
