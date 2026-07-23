/**
 * bounded-fanout — like parallelFanout, but caps in-flight runners.
 *
 * The reason this exists: most local inference setups have a hard concurrency
 * cap (e.g. vLLM's `--max-num-seqs`). Sending 200 requests at once when the
 * server only decodes 4 at a time gives you no extra throughput, no progress
 * visibility, and head-of-line blocking. Bounded fanout matches concurrency
 * to the real bottleneck and lets you observe per-item completion via the
 * optional `onItemDone` callback.
 *
 * Result order matches input order, regardless of completion order.
 *
 * # Failure semantics
 *
 * Two modes via `options.mode`:
 *
 * - `'reject'` (default; backwards-compatible): if any runner throws, this
 *   rejects with the first thrown error. In-flight workers stop pulling new
 *   items but the runner already-in-flight on the failing path has already
 *   thrown. Other in-flight runners' resolved results are discarded.
 *
 * - `'collect'`: never reject due to a runner throw. Each result slot is
 *   `{ ok: true, value }` or `{ ok: false, error }`, in input order. Use
 *   this when partial-results-on-failure is what you want — common for
 *   batch agent runs where one item failing shouldn't drop the rest.
 *
 * `onItemError` fires regardless of mode, before the rejection in `'reject'`
 * mode and once per failed item in `'collect'` mode. Use it for telemetry.
 * Callback failures are mechanical failures and reject in both modes.
 *
 * # Cancellation
 *
 * Pass an `AbortSignal` via `options.signal`. Once aborted:
 *
 *   - No new items are dispatched off the cursor.
 *   - The signal is forwarded to runners as the third argument
 *     (`runner(item, index, signal)`), so a runner that respects it can
 *     unwind early — e.g. by passing it into `runAgentWithTools({signal})`.
 *
 * Cancellation interacts with `mode`:
 *
 *   - `'reject'`: hard-cancel. The fanout rejects with the abort reason.
 *     Partial results are discarded.
 *   - `'collect'`: soft-cancel. Returns a full-length, position-stable
 *     `FanOutResult<T>[]` — items that completed before the abort keep
 *     their `{ ok: true, value }` or `{ ok: false, error }`, items that
 *     were never started (or whose runner exited via the in-loop signal
 *     check) get a synthetic `{ ok: false, error: AbortError }`. The
 *     fanout does NOT reject. Use this when you want a soft deadline
 *     that returns work-in-progress for downstream phases to flush.
 *
 * For per-item progress as items complete, use `onItemDone` (it fires in
 * completion order, before the final result array is returned).
 */
export interface ItemDoneEvent<TItem, TResult> {
    item: TItem;
    index: number;
    result: TResult;
}
export interface ItemErrorEvent<TItem> {
    item: TItem;
    index: number;
    error: Error;
}
export type FanOutResult<TResult> = {
    ok: true;
    value: TResult;
} | {
    ok: false;
    error: Error;
};
export interface BoundedFanOutOptions<TItem, TResult> {
    items: ReadonlyArray<TItem>;
    /** Max concurrent runners. Default 4; must be a positive safe integer. */
    concurrency?: number;
    /** If set, only the first `maxItems` items are processed. */
    maxItems?: number;
    /**
     * Per-item runner. Receives the item, its index in the (capped) list, and
     * the cancellation signal if one was passed. Forward `signal` into any
     * abortable downstream call (HTTP, `runAgentWithTools`) for clean
     * mid-flight cancellation.
     */
    runner: (item: TItem, index: number, signal?: AbortSignal) => Promise<TResult>;
    /** Fires once per successfully-completed item, in completion order. */
    onItemDone?: (event: ItemDoneEvent<TItem, TResult>) => void;
    /**
     * Failure mode:
     *   - `'reject'` (default): first throw rejects the whole call.
     *   - `'collect'`: never reject; each slot is FanOutResult.
     */
    mode?: 'reject' | 'collect';
    /**
     * Fires when a runner throws. Independent of mode; in `'reject'` mode it
     * fires before the rejection propagates so you can record context for
     * logging, in `'collect'` mode it fires per failed item.
     */
    onItemError?: (event: ItemErrorEvent<TItem>) => void;
    /**
     * Cancellation signal. When aborted, no new items are dispatched, the
     * signal is forwarded to runners as the third argument, and the fanout
     * rejects with the abort reason.
     */
    signal?: AbortSignal;
}
export declare function boundedFanout<TItem, TResult>(options: BoundedFanOutOptions<TItem, TResult> & {
    mode: 'collect';
}): Promise<FanOutResult<TResult>[]>;
export declare function boundedFanout<TItem, TResult>(options: BoundedFanOutOptions<TItem, TResult> & {
    mode?: 'reject';
}): Promise<TResult[]>;
//# sourceMappingURL=bounded-fanout.d.ts.map