// Adapter implementations will be exported from here as they land.

export {
  acpAgent,
  createAcpAdapter,
  JsonRpcCallError,
  type AcpAgentConfig,
  type CreateAcpAdapterOptions,
  type AcpAgentCapabilities,
  type AuthMethod,
  type ClientCapabilities,
  type ContentBlock,
  type Implementation,
  type McpServer,
  type SessionId,
  type StopReason,
  type ToolCallStatus,
} from './acp/index.js';

export { hermesAgent, type HermesAgentConfig } from './hermes/index.js';
export { openClawAgent, type OpenClawAgentConfig } from './openclaw/index.js';
export { anthropicAgent, type AnthropicAgentConfig } from './anthropic/index.js';
export { codexAgent, type CodexAgentConfig } from './codex/index.js';
export { codexCliAgent, type CodexCliAgentConfig } from './codex-cli/index.js';
export { claudeCodeAgent, type ClaudeCodeAgentConfig } from './claude-code/index.js';
export { piAgent, type PiAgentConfig } from './pi/index.js';

// Pre-built inject callbacks for withMemory / withThread.
export { injectMemory, injectResume } from './injectors.js';

// Thread → adapter-input rendering helpers for cross-adapter handoff.
export {
  threadToTranscript,
  threadToAcpPrompt,
  threadToAnthropicMessages,
  threadToClaudeCodePrompt,
  threadToCodexInput,
  threadToMessages,
} from './thread-bridge.js';

// ---------------------------------------------------------------------------
// Re-exports from `@autonome-research/thread-phase/agents` (Tier A, stable
// from v4.0.0) for the common consumer + chain-builder cases. Importing
// from `-agents` keeps the import surface to one place when you're using
// adapters or chaining them.
//
// Canonical home is still `@autonome-research/thread-phase/agents`; these
// are pure re-exports. Author-only helpers (`composeAbort`, `createEventQueue`,
// `lazyEvents`, `TurnAccumulator`, `serializeError`, the structured-output
// runtime helpers, `requireCapability`) now live at
// `@autonome-research/thread-phase/agents/authoring` (Tier B, unstable).
// They are intentionally NOT re-exported here — consumers shouldn't need
// them; new adapter authors import directly from /authoring.
// ---------------------------------------------------------------------------

export {
  // Event bus — pipe adapter events to a shared subscriber surface
  createEventBus,
  // EventBus → JobStore bridge for persistent event logs
  pipeAgentEventsToJobStore,
  // Thread primitive + helpers for cross-adapter state
  createThread,
  appendEvent,
  resumeTokenFor,
  setResumeToken,
  // Adapter decorators for memory + thread wiring
  withMemory,
  withThread,
  // Capability narrowing
  isSteerable,
} from '@autonome-research/thread-phase/agents';

export type {
  // Adapter protocol types
  AgentAdapter,
  AgentAdapterMeta,
  AgentCapabilities,
  AgentEvent,
  AgentEventBus,
  AgentFinishReason,
  AgentRun,
  AgentRunOptions,
  AgentRunResult,
  ResumeToken,
  SerializableError,
  SteerableAgentRun,
  // Thread + memory types
  Thread,
  MemoryProvider,
  MemoryScope,
  // Decorator option shapes
  WithMemoryOptions,
  WithThreadOptions,
  // Bridge options
  PipeAgentEventsOptions,
} from '@autonome-research/thread-phase/agents';
