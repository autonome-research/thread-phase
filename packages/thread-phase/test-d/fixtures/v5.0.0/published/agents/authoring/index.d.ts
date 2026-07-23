/**
 * Adapter-author helpers — Tier B, UNSTABLE surface.
 *
 * # Stability policy
 *
 * Everything exported from this subpath is for AUTHORS writing new
 * AgentAdapter implementations — not for consumers using pre-built
 * adapters. These helpers may change shape in any minor release.
 *
 * If you are writing application code that USES an adapter (e.g.
 * `claudeCodeAgent`, `codexAgent`), you want `thread-phase/agents`
 * (Tier A, stable) — not this subpath.
 *
 * If you are writing a new adapter from scratch, this is the right
 * place. Treat every import from here as a churn risk and pin to the
 * exact version of `@autonome-research/thread-phase` you tested
 * against.
 *
 * See STABILITY.md at the repo root for the full tier policy.
 *
 * # What lives here
 *
 *   - run-helpers: composeAbort, createEventQueue, lazyEvents — the
 *     three implementation primitives every concrete adapter in
 *     `thread-phase-agents` consumes.
 *   - TurnAccumulator: helper for runtimes whose wire-format emits
 *     turn boundaries before tool calls (used by codex, anthropic).
 *   - serializeError: cross-process-safe error normalization. Used by
 *     adapters when emitting AgentEvent error frames.
 *   - parseStructuredFromText / extractResponseBlock /
 *     applyStructuredOutputPrompt / parseStructured: prompted
 *     structured-output helpers. The TYPE exports
 *     (StructuredOutputConfig, StructuredOutputParseError) live in
 *     the consumer barrel — only the runtime helpers are author-only.
 *   - capability: AgentCapabilityError + requireCapability for static
 *     adapter-capability validation. Zero importers in the bundled
 *     adapters today; kept here for protocol completeness.
 *     TODO(v5): re-evaluate for removal if still unused.
 *   - parseStructuredFromText is the closest to a Tier A candidate —
 *     six bundled adapters consume it. If consumer-facing re-parse
 *     ever becomes a documented use case, promote with a stable
 *     wrapper.
 */
export { composeAbort, createEventQueue, lazyEvents, type CompositeAbort, type EventQueue, } from '../run-helpers.js';
export { TurnAccumulator } from '../turn-accumulator.js';
export { serializeError } from '../serialize-error.js';
export { applyStructuredOutputPrompt, extractResponseBlock, parseStructured, parseStructuredFromText, } from '../structured-output.js';
export { AgentCapabilityError, requireCapability } from '../capability.js';
export { superviseChild, type SuperviseChildOptions, type SuperviseChildHandle, } from './supervise-child.js';
//# sourceMappingURL=index.d.ts.map