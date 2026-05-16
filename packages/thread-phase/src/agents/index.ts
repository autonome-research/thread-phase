/**
 * Public entry point for the AgentAdapter protocol.
 *
 * The protocol surface is currently `@internal` — covered by no semver
 * guarantee until the first stable release of `thread-phase-agents`. Until
 * then, every export here may change in a minor version.
 *
 * Subpath: `thread-phase/agents`.
 */

// Protocol types.
export {
  defineAgentAdapter,
  type AgentAdapter,
  type AgentAdapterMeta,
  type AgentCapabilities,
  type AgentEvent,
  type AgentEventBus,
  type AgentFinishReason,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
  type ResumeToken,
  type SerializableError,
  type SteerableAgentRun,
} from './protocol.js';

// Event bus.
export { createEventBus } from './event-bus.js';

// Capability assertions.
export { AgentCapabilityError, requireCapability } from './capability.js';

// Error serialization helper.
export { serializeError } from './serialize-error.js';

// Thread primitive.
export {
  appendEvent,
  createThread,
  resumeTokenFor,
  setResumeToken,
  threadToMessages,
  type Thread,
} from './thread.js';

// Memory provider interface.
export type { MemoryProvider, MemoryScope } from './memory.js';

// Structured-output helpers (prompted path).
export {
  applyStructuredOutputPrompt,
  extractResponseBlock,
  parseStructured,
  parseStructuredFromText,
  StructuredOutputParseError,
  type StructuredOutputConfig,
} from './structured-output.js';

// Reference adapter — wraps runAgentWithTools.
export {
  inferenceAgent,
  type InferenceAgentConfig,
} from './inference-adapter.js';
