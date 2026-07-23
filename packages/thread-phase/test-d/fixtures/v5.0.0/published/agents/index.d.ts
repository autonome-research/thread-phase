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
export { defineAgentAdapter, isSteerable, type AgentAdapter, type AgentAdapterMeta, type AgentCapabilities, type AgentEvent, type AgentEventBus, type AgentFinishReason, type AgentRun, type AgentRunOptions, type AgentRunResult, type ResumeToken, type SerializableError, type SteerableAgentRun, } from './protocol.js';
export { createEventBus } from './event-bus.js';
export { appendEvent, createThread, resumeTokenFor, setResumeToken, threadToMessages, type Thread, } from './thread.js';
export type { MemoryProvider, MemoryScope } from './memory.js';
export { StructuredOutputParseError, type StructuredOutputConfig, } from './structured-output.js';
export { inferenceAgent, type InferenceAgentConfig, } from './inference-adapter.js';
export { withMemory, type WithMemoryOptions } from './with-memory.js';
export { withThread, type WithThreadOptions } from './with-thread.js';
export { pipeAgentEventsToJobStore, type PipeAgentEventsOptions, } from './job-store-bridge.js';
//# sourceMappingURL=index.d.ts.map