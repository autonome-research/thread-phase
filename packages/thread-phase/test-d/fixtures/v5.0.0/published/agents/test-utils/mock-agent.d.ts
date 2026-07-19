/**
 * Scripted `AgentAdapter` for tests.
 *
 * `createMockAgent` returns a `AgentAdapterMeta` whose adapter replays a
 * configured sequence of `AgentEvent`s and resolves with a configured
 * `AgentRunResult`. The mock honors the protocol's lifecycle invariants:
 * exactly one `agent_start`, exactly one trailing `agent_end`, `result`
 * always resolves, `abort()` is idempotent, `options.signal` is observed.
 *
 * Used by in-tree tests targeting the AgentAdapter surface and by the
 * conformance suite as the self-test adapter.
 *
 * @internal
 */
import { type AgentAdapterMeta, type AgentCapabilities, type AgentEvent, type AgentRunResult } from '../protocol.js';
/**
 * Scripted invocation of the mock adapter. The adapter emits exactly the
 * events in `events`, in order, then resolves `result` with the scripted
 * value. Lifecycle events (`agent_start`, `agent_end`) are added by the
 * adapter — do not include them in `events`.
 *
 * @internal
 */
export interface MockAgentConfig {
    /** Events to emit, in order. Should NOT include agent_start or agent_end. */
    events: ReadonlyArray<AgentEvent>;
    /** Final result. agent_end.reason will mirror result.finishReason. */
    result: AgentRunResult;
    /**
     * Delay in ms between scripted events. 0 = a microtask hop per event.
     * Default 0. Use a positive value to exercise consumers that need to
     * interleave with async work.
     */
    perEventDelayMs?: number;
    /**
     * If set, the adapter throws this when called. Used to test how callers
     * handle adapter-construction-time failures (vs run-time errors which
     * should still resolve `result`).
     */
    throwOnConstruct?: Error;
}
/**
 * Override knobs for the mock adapter's metadata. Defaults match a minimal
 * adapter: `streaming: 'text'`, `cancellation: 'cooperative'`,
 * `resumption: 'none'`, `structuredOutput: 'none'`.
 *
 * @internal
 */
export interface CreateMockAgentOptions {
    id?: string;
    capabilities?: Partial<AgentCapabilities>;
}
/**
 * Default capabilities used when none are overridden.
 *
 * @internal
 */
export declare const MOCK_DEFAULT_CAPABILITIES: AgentCapabilities;
/**
 * Build a mock adapter suitable for testing pattern code and any consumer
 * targeting the AgentAdapter protocol.
 *
 * @internal
 */
export declare function createMockAgent(opts?: CreateMockAgentOptions): AgentAdapterMeta<MockAgentConfig>;
//# sourceMappingURL=mock-agent.d.ts.map