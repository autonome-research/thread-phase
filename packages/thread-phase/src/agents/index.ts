/**
 * Public entry point for the AgentAdapter protocol — Tier A, STABLE surface.
 *
 * # Stability commitment (from v4.0.0)
 *
 * Every export from this subpath is covered by semver:
 *   - patch (4.0.x): bug fixes, no API changes
 *   - minor (4.x.0): additive — new exports, new optional fields
 *   - major (x.0.0): breaking changes (always with a migration note)
 *
 * Anyone building application code that uses or composes pre-built
 * adapters (`claudeCodeAgent`, `codexAgent`, `hermesAgent`, …) imports
 * from here.
 *
 * Helpers for AUTHORING new adapters — `composeAbort`, `createEventQueue`,
 * `lazyEvents`, `TurnAccumulator`, `serializeError`, the prompted
 * structured-output helpers, `requireCapability` — live in
 * `thread-phase/agents/authoring` and remain unstable.
 *
 * See STABILITY.md at the repo root for the full tier policy.
 *
 * Subpath: `thread-phase/agents`.
 */

// Protocol types.
export {
  defineAgentAdapter,
  isSteerable,
  type AgentAdapter,
  type AgentAdapterMeta,
  type AgentCapabilities,
  type AgentEvent,
  type AgentEventBus,
  type AgentEventHandler,
  type AgentEventHandlerFailure,
  type AgentFinishReason,
  type ObservableAgentEventBus,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
  type ResumeToken,
  type SerializableError,
  type SteerableAgentRun,
} from './protocol.js';

// Event bus.
export { createEventBus } from './event-bus.js';

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

// Structured-output TYPES live in the stable barrel. The corresponding
// runtime helpers (parseStructuredFromText, extractResponseBlock,
// applyStructuredOutputPrompt, parseStructured) are author-only and
// live in `thread-phase/agents/authoring`.
export {
  StructuredOutputParseError,
  type StructuredOutputConfig,
} from './structured-output.js';

// Reference adapter — wraps runAgentWithTools. inferenceAgent is shipped
// as both a working adapter and the canonical example for adapter authors.
export {
  inferenceAgent,
  type InferenceAgentConfig,
} from './inference-adapter.js';

// Adapter decorators: auto-handle memory and Thread wiring.
export { withMemory, type WithMemoryOptions } from './with-memory.js';
export { withThread, type WithThreadOptions } from './with-thread.js';

// Bridge adapter events to a JobStore event log.
export {
  createAgentEventPersistenceBridge,
  persistAgentEventsToJobStore,
  pipeAgentEventsToJobStore,
  type AgentEventPersistenceBridge,
  type AgentEventPersistenceFailure,
  type AgentEventPersistenceFailureHandler,
  type AgentEventPersistenceFailureKind,
  type AgentEventPersistenceOptions,
  type PipeAgentEventsOptions,
} from './job-store-bridge.js';
