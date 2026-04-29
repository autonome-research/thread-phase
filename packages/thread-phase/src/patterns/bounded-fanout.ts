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
 * Failure semantics mirror parallelFanout (Promise.all): if any runner
 * throws, this rejects with the first thrown error. In-flight runners
 * complete but their results are discarded. Wrap your runner with try/catch
 * if you want partial-results-on-failure.
 */

export interface ItemDoneEvent<TItem, TResult> {
  item: TItem;
  index: number;
  result: TResult;
}

export interface BoundedFanOutOptions<TItem, TResult> {
  items: ReadonlyArray<TItem>;
  /** Max concurrent runners. Default 4. Clamped to [1, items.length]. */
  concurrency?: number;
  /** If set, only the first `maxItems` items are processed. */
  maxItems?: number;
  runner: (item: TItem, index: number) => Promise<TResult>;
  /** Fires once per item, in completion order. */
  onItemDone?: (event: ItemDoneEvent<TItem, TResult>) => void;
}

export async function boundedFanout<TItem, TResult>(
  options: BoundedFanOutOptions<TItem, TResult>,
): Promise<TResult[]> {
  const items =
    options.maxItems !== undefined ? options.items.slice(0, options.maxItems) : options.items;

  if (items.length === 0) return [];

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, items.length));
  const results: Array<TResult | undefined> = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      const result = await options.runner(item, i);
      results[i] = result;
      options.onItemDone?.({ item, index: i, result });
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  return results as TResult[];
}
