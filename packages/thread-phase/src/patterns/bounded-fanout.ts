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
 *
 * Cancellation: pass an `AbortSignal`. Once aborted, no new items are
 * dispatched; in-flight items are NOT torn down (the signal must be
 * observed inside the runner if you want that). The fanout rejects with
 * the abort reason.
 *
 * For per-item progress as items complete (rather than only at the end),
 * see `streamingBoundedFanout`.
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
  /**
   * Cancellation signal. When aborted, no new items are dispatched and
   * the fanout rejects with the abort reason. Already-running runners
   * continue unless they observe the signal themselves.
   */
  signal?: AbortSignal;
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
  const signal = options.signal;

  if (signal?.aborted) {
    throw signalAbortError(signal);
  }

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      const result = await options.runner(item, i);
      if (signal?.aborted) return;
      results[i] = result;
      options.onItemDone?.({ item, index: i, result });
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  if (signal?.aborted) {
    throw signalAbortError(signal);
  }

  return results as TResult[];
}

// ---------------------------------------------------------------------------
// streamingBoundedFanout — same scheduling, but yielded as an AsyncGenerator
// of per-item completion events plus a final 'done' event with the full
// ordered result array.
//
// Use this when you're inside a Phase and want progress visibility *during*
// the fanout instead of only at the end — for instance, a long batch where
// emitting milestone events post-hoc isn't enough.
// ---------------------------------------------------------------------------

export type StreamingFanoutEvent<TItem, TResult> =
  | {
      type: 'item_done';
      item: TItem;
      index: number;
      result: TResult;
      /** 0..1, fraction of items completed including this one. */
      progress: number;
    }
  | { type: 'done'; results: TResult[] };

export async function* streamingBoundedFanout<TItem, TResult>(
  options: BoundedFanOutOptions<TItem, TResult>,
): AsyncGenerator<StreamingFanoutEvent<TItem, TResult>, void, void> {
  const items =
    options.maxItems !== undefined ? options.items.slice(0, options.maxItems) : options.items;

  if (items.length === 0) {
    yield { type: 'done', results: [] };
    return;
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, items.length));
  const results: Array<TResult | undefined> = new Array(items.length);
  const signal = options.signal;

  if (signal?.aborted) {
    throw signalAbortError(signal);
  }

  // Producer/consumer queue: workers push completion events, the generator
  // drains them and yields downstream. We can't `yield` from inside a
  // worker, so we route through a queue.
  type Pending = { item: TItem; index: number; result: TResult };
  const queue: Pending[] = [];
  let resolveWaiter: (() => void) | null = null;
  const wake = () => {
    const fn = resolveWaiter;
    resolveWaiter = null;
    fn?.();
  };
  const wait = () => new Promise<void>((r) => (resolveWaiter = r));

  let cursor = 0;
  let done = 0;
  let errored: unknown = null;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      if (errored) return;
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        const result = await options.runner(item, i);
        if (signal?.aborted) return;
        results[i] = result;
        options.onItemDone?.({ item, index: i, result });
        queue.push({ item, index: i, result });
        wake();
      } catch (err) {
        errored = err;
        wake();
        return;
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());

  const allDone = Promise.all(workers).finally(wake);

  while (done < items.length) {
    if (errored) throw errored;
    if (signal?.aborted) throw signalAbortError(signal);
    if (queue.length === 0) {
      await Promise.race([wait(), allDone]);
      if (errored) throw errored;
      if (signal?.aborted) throw signalAbortError(signal);
      if (queue.length === 0 && done < items.length) {
        // Workers all finished but we didn't get all results — possible only
        // if items array changed mid-flight, which shouldn't happen.
        break;
      }
      continue;
    }
    const ev = queue.shift()!;
    done++;
    yield {
      type: 'item_done',
      item: ev.item,
      index: ev.index,
      result: ev.result,
      progress: done / items.length,
    };
  }

  await allDone;
  if (errored) throw errored;
  yield { type: 'done', results: results as TResult[] };
}

function signalAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}
