/**
 * Decorate an `AgentAdapter` with automatic memory recall + remember
 * via a caller-supplied `MemoryProvider`.
 *
 * The wrapper:
 *
 *   1. Reads `runOptions.memoryProvider` at call time. If none is in
 *      scope, the wrapper is a no-op pass-through — caller can decorate
 *      an adapter once and decide per-call whether memory applies.
 *   2. Before invoking the inner adapter, calls `provider.recall(scope, query?)`
 *      and splices the recalled string into the config via the
 *      `inject` callback. The inject signature is adapter-specific
 *      because each adapter shapes its prompt field differently
 *      (config.systemPrompt vs config.instructions vs config.prompt vs
 *      runnerOptions etc.).
 *   3. Tees every emitted event into a capture buffer (for the later
 *      `remember` call) AND into the caller's `options.eventBus` if
 *      present. Pass-through; no events added or dropped.
 *   4. After the inner run's `agent_end`, calls `provider.remember(scope, captured)`
 *      before resolving the wrapped run's `result`. Failures of either
 *      `recall` or `remember` surface as `native` events on the bus
 *      (`memory:recall_failed` / `memory:remember_failed`); the run
 *      itself never fails because of memory.
 *
 */
import type { AgentAdapterMeta, MemoryScope } from './protocol.js';
export interface WithMemoryOptions<TConfig> {
    /** Identity scope (`userId` required; `appId` / `sessionId` optional). */
    scope: MemoryScope;
    /**
     * Splice the recalled memory string into the inner adapter's config.
     * Each adapter shapes its prompt field differently; the caller knows
     * the adapter type and where the memory belongs.
     */
    inject: (config: TConfig, memory: string) => TConfig;
    /**
     * Optional: derive a query string from the config to refine recall.
     * Useful when the recall backend supports semantic search (Honcho's
     * `.chat()` interprets the query as the question being asked).
     * Default: no query (provider gets `undefined`).
     */
    query?: (config: TConfig) => string | undefined;
}
/**
 * Wrap an adapter so each invocation auto-recalls memory before the run
 * and auto-remembers events after. Behavior is gated on the presence
 * of `options.memoryProvider` at call time — no provider, no memory
 * activity.
 *
 */
export declare function withMemory<TConfig>(meta: AgentAdapterMeta<TConfig>, opts: WithMemoryOptions<TConfig>): AgentAdapterMeta<TConfig>;
//# sourceMappingURL=with-memory.d.ts.map