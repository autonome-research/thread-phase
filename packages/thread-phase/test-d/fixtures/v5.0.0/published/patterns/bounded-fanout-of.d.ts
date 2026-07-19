/**
 * `boundedFanoutOf` — fan an `AgentAdapter` over N items with capped
 * concurrency, with automatic event-bus propagation so every parallel
 * adapter run lands events on one shared bus.
 *
 * Shape captured: same as `boundedFanout`, but the per-item runner is an
 * adapter + buildConfig pair instead of a free function. The adapter's
 * canonical AgentEvents — including events from all N parallel runs —
 * fan into one `options.eventBus` for downstream consumers (JobStore,
 * SSE, audit log). Cancellation propagates from `options.signal` to
 * every in-flight adapter call.
 *
 * When to reach for this: you have a list of items, you want to run a
 * pre-built agent (claude code, hermes, anthropic) on each, with capped
 * concurrency, and you want a single event stream for the whole batch.
 *
 * When NOT to use: when you control the per-item runner directly (no
 * adapter abstraction in play), reach for `boundedFanout` — its callback
 * form is more direct. When you have one item, just call the adapter
 * directly.
 *
 * Stable surface — exported via thread-phase/patterns; covered by semver.
 */
import type { AgentAdapterMeta, AgentEventBus, AgentRunResult } from '../agents/protocol.js';
/** Per-item failure handling. Mirrors boundedFanout's mode. */
export type BoundedFanoutOfMode = 'fail-fast' | 'collect';
export interface BoundedFanoutOfOptions<TItem, TConfig> {
    items: ReadonlyArray<TItem>;
    concurrency: number;
    adapter: AgentAdapterMeta<TConfig>;
    buildConfig: (item: TItem, index: number) => TConfig;
    signal?: AbortSignal;
    /** Shared event bus — every per-item adapter run mirrors events here. */
    eventBus?: AgentEventBus;
    /** Optional traceId propagated into each adapter's options.traceId. */
    traceId?: string;
    /**
     * Default `fail-fast`. `collect` collects adapter results whose
     * finishReason is `error`; mechanical setup/result/callback exceptions still
     * reject because no valid AgentRunResult exists to place in that slot.
     */
    mode?: BoundedFanoutOfMode;
    /** Called when an item's adapter result is in. Synchronous-only. */
    onItemEnd?: (item: TItem, index: number, result: AgentRunResult) => void;
    /** Called when fail-fast is triggered. The first failing index/result is passed. */
    onItemError?: (item: TItem, index: number, result: AgentRunResult) => void;
}
/**
 * Run an adapter over N items with capped concurrency. Returns results in
 * input order. In `collect` mode, individual failures are stored as
 * error results (finishReason: 'error') and the batch completes. In
 * `fail-fast` (default), the first failure cancels in-flight runs and
 * the function rejects with an Error wrapping the failed item.
 */
export declare function boundedFanoutOf<TItem, TConfig>(opts: BoundedFanoutOfOptions<TItem, TConfig>): Promise<AgentRunResult[]>;
export declare class BoundedFanoutOfError extends Error {
    itemIndex: number;
    result: AgentRunResult;
    constructor(itemIndex: number, result: AgentRunResult);
}
//# sourceMappingURL=bounded-fanout-of.d.ts.map