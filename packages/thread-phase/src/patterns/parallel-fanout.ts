/**
 * parallel-fanout — N items, one async runner per item, results collected.
 *
 * The most common multi-agent pattern: "for each X, do Y." Caps concurrency
 * optionally.
 *
 * Intentionally a helper, not a Phase. Compose inside your own phase:
 *
 *   async *run(ctx) {
 *     const items = requireCtx(ctx, 'items', 'my-phase');
 *     yield { type: 'phase', phase: 'my-phase', detail: `${items.length} items` };
 *     const results = await parallelFanout({
 *       items,
 *       maxItems: 5,
 *       runner: (item) => runAgentWithTools(myConfig, [...], opts),
 *     });
 *     ctx.results = results;
 *   }
 */

export interface FanOutOptions<TItem, TResult> {
  items: ReadonlyArray<TItem>;
  /** If set, only the first `maxItems` items are processed. */
  maxItems?: number;
  /** Per-item runner. Receives the item and its index in the (capped) list. */
  runner: (item: TItem, index: number) => Promise<TResult>;
}

export async function parallelFanout<TItem, TResult>(
  options: FanOutOptions<TItem, TResult>,
): Promise<TResult[]> {
  const items =
    options.maxItems !== undefined ? options.items.slice(0, options.maxItems) : options.items;
  return Promise.all(items.map((item, i) => options.runner(item, i)));
}
