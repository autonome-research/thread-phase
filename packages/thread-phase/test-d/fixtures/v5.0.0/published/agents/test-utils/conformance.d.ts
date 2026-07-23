/**
 * Parameterized vitest suite that asserts an `AgentAdapter` honors the
 * protocol's lifecycle invariants. Both in-tree tests and the sibling
 * `@autonome-research/thread-phase-agents` package import this and call it from a `describe`
 * or top-level test file.
 *
 * Invariants asserted (see `protocol.ts` for the canonical statements):
 *   - exactly one `agent_start` at the head of the stream,
 *   - exactly one `agent_end` at the tail of the stream,
 *   - `result` resolves and never rejects,
 *   - `result.finishReason` matches `agent_end.reason`,
 *   - `abort()` is idempotent and yields `finishReason: 'aborted'`,
 *   - `options.signal` is observed,
 *   - `options.eventBus` mirrors the full event stream,
 *   - every event carries `source === meta.id`,
 *   - the `events` AsyncIterable terminates,
 *   - `events` is single-consumer (second iteration attempt throws),
 *   - `events` iterator `return()` cleanly closes the stream,
 *   - `result` resolves even when `events` is never iterated.
 *
 * Adapters that can synthesize internal-error runs supply `buildErrorConfig`
 * to additionally assert the resolve-not-reject invariant on the error path.
 *
 * @internal
 */
import type { AgentAdapterMeta } from '../protocol.js';
/**
 * Per-adapter config-builder. Each invocation must return a fresh config
 * suitable for one run. Caller controls how prompts/messages are shaped.
 *
 * @internal
 */
export type ConformanceConfigBuilder<TConfig> = () => TConfig;
/**
 * Options for running the conformance suite against an adapter.
 *
 * @internal
 */
export interface RunConformanceSuiteOptions<TConfig> {
    meta: AgentAdapterMeta<TConfig>;
    buildConfig: ConformanceConfigBuilder<TConfig>;
    /**
     * Optional: build a config that should produce a runner-internal error.
     * Used to test the "result resolves rather than rejects on error" invariant.
     * If omitted, that test is skipped. Sibling adapters that can't reliably
     * trigger an internal error may omit this safely.
     */
    buildErrorConfig?: ConformanceConfigBuilder<TConfig>;
    /** Per-test timeout in ms. Default 10_000. */
    timeoutMs?: number;
}
/**
 * Run the full conformance suite against an adapter. Registers its own
 * `describe` block.
 *
 * @internal
 */
export declare function runAdapterConformance<TConfig>(opts: RunConformanceSuiteOptions<TConfig>): void;
//# sourceMappingURL=conformance.d.ts.map