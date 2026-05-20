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
 * For per-item progress as items complete, see `streamingBoundedFanout`.
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

export type FanOutResult<TResult> =
  | { ok: true; value: TResult }
  | { ok: false; error: Error };

export interface BoundedFanOutOptions<TItem, TResult> {
  items: ReadonlyArray<TItem>;
  /** Max concurrent runners. Default 4. Clamped to [1, items.length]. */
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

// Function overloads so the return type discriminates on `mode`.
export function boundedFanout<TItem, TResult>(
  options: BoundedFanOutOptions<TItem, TResult> & { mode: 'collect' },
): Promise<FanOutResult<TResult>[]>;
export function boundedFanout<TItem, TResult>(
  options: BoundedFanOutOptions<TItem, TResult> & { mode?: 'reject' },
): Promise<TResult[]>;
export async function boundedFanout<TItem, TResult>(
  options: BoundedFanOutOptions<TItem, TResult>,
): Promise<TResult[] | FanOutResult<TResult>[]> {
  const items =
    options.maxItems !== undefined ? options.items.slice(0, options.maxItems) : options.items;

  if (items.length === 0) return [];

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, items.length));
  const collect = options.mode === 'collect';
  const results: Array<TResult | FanOutResult<TResult> | undefined> = new Array(items.length);
  let cursor = 0;
  const signal = options.signal;

  // Already aborted before any dispatch.
  //   - 'reject' mode: throw, matches HTTP-cancel semantics.
  //   - 'collect' mode: short-circuit with synthetic AbortError slots so
  //     consumers always get a full-length, position-stable array.
  if (signal?.aborted) {
    if (collect) return fillAbortedSlots([], items.length, signal);
    throw signalAbortError(signal);
  }

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        const result = await options.runner(item, i, signal);
        if (signal?.aborted) return;
        if (collect) {
          results[i] = { ok: true, value: result };
        } else {
          results[i] = result;
        }
        options.onItemDone?.({ item, index: i, result });
      } catch (rawErr) {
        const error = toError(rawErr);
        options.onItemError?.({ item, index: i, error });
        if (collect) {
          results[i] = { ok: false, error };
          continue; // keep draining
        }
        throw error; // 'reject' mode: bubble out, Promise.all will reject
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  // Aborted at some point after dispatch began.
  //   - 'reject' mode: throw, partial results discarded (matches v1.0/1.1).
  //   - 'collect' mode: soft-cancel — return what completed, fill the slots
  //     of items that were never started (or whose runner exited via the
  //     in-loop signal check before writing a result) with synthetic
  //     AbortError FanOutResults. onItemError does NOT fire for these
  //     synthetic fills — the runner never ran for them.
  if (signal?.aborted) {
    if (collect) {
      return fillAbortedSlots(results as Array<FanOutResult<TResult> | undefined>, items.length, signal);
    }
    throw signalAbortError(signal);
  }

  return results as TResult[] | FanOutResult<TResult>[];
}

// ---------------------------------------------------------------------------
// streamingBoundedFanout — same scheduling, but yielded as an AsyncGenerator
// of per-item completion events plus a final 'done' event with the full
// ordered result array.
//
// Use this when you're inside a Phase and want progress visibility *during*
// the fanout instead of only at the end — for instance, a long batch where
// emitting milestone events post-hoc isn't enough.
//
// Mode + onItemError + signal forwarding work the same as boundedFanout. In
// 'collect' mode, errors yield `item_error` events instead of throwing, and
// the final `done` event carries `FanOutResult<T>[]`.
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
  | {
      type: 'item_error';
      item: TItem;
      index: number;
      error: Error;
      /** 0..1, fraction of items completed including this one. */
      progress: number;
    }
  | { type: 'done'; results: TResult[] }
  | { type: 'done_collected'; results: FanOutResult<TResult>[] };

export function streamingBoundedFanout<TItem, TResult>(
  options: BoundedFanOutOptions<TItem, TResult> & { mode: 'collect' },
): AsyncGenerator<StreamingFanoutEvent<TItem, TResult>, void, void>;
export function streamingBoundedFanout<TItem, TResult>(
  options: BoundedFanOutOptions<TItem, TResult> & { mode?: 'reject' },
): AsyncGenerator<StreamingFanoutEvent<TItem, TResult>, void, void>;
export async function* streamingBoundedFanout<TItem, TResult>(
  options: BoundedFanOutOptions<TItem, TResult>,
): AsyncGenerator<StreamingFanoutEvent<TItem, TResult>, void, void> {
  const items =
    options.maxItems !== undefined ? options.items.slice(0, options.maxItems) : options.items;

  const collect = options.mode === 'collect';

  if (items.length === 0) {
    yield collect
      ? { type: 'done_collected', results: [] }
      : { type: 'done', results: [] };
    return;
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, items.length));
  const results: Array<TResult | FanOutResult<TResult> | undefined> = new Array(items.length);
  const signal = options.signal;

  // Already aborted before any dispatch — same shape as boundedFanout's
  // early-abort: 'reject' throws, 'collect' yields a done_collected event
  // with all-AbortError slots and exits cleanly.
  if (signal?.aborted) {
    if (collect) {
      yield {
        type: 'done_collected',
        results: fillAbortedSlots([], items.length, signal),
      };
      return;
    }
    throw signalAbortError(signal);
  }

  // Producer/consumer queue: workers push completion/error events, the
  // generator drains them and yields downstream.
  type Pending =
    | { kind: 'done'; item: TItem; index: number; result: TResult }
    | { kind: 'error'; item: TItem; index: number; error: Error };
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
  let errored: Error | null = null;

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      if (errored) return; // 'reject' mode: stop pulling once the batch has failed
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        const result = await options.runner(item, i, signal);
        if (signal?.aborted) return;
        if (collect) {
          results[i] = { ok: true, value: result };
        } else {
          results[i] = result;
        }
        options.onItemDone?.({ item, index: i, result });
        queue.push({ kind: 'done', item, index: i, result });
        wake();
      } catch (rawErr) {
        const error = toError(rawErr);
        options.onItemError?.({ item, index: i, error });
        if (collect) {
          results[i] = { ok: false, error };
          queue.push({ kind: 'error', item, index: i, error });
          wake();
          // keep draining
        } else {
          errored = error;
          wake();
          return;
        }
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());

  const allDone = Promise.all(workers).finally(wake);

  while (done < items.length) {
    if (errored) throw errored;
    // 'reject' mode: hard-cancel on signal. 'collect' mode: keep draining
    // the queue (workers exit early via their own signal check, so the
    // loop will run out of events naturally and exit via the
    // queue-empty-and-allDone branch below).
    if (signal?.aborted && !collect) throw signalAbortError(signal);
    if (queue.length === 0) {
      await Promise.race([wait(), allDone]);
      if (errored) throw errored;
      if (signal?.aborted && !collect) throw signalAbortError(signal);
      if (queue.length === 0 && done < items.length) {
        // Either soft-cancel in collect mode (workers exited without
        // producing more events) or items array changed mid-flight.
        // Either way, exit and let the post-loop emit what we have.
        break;
      }
      continue;
    }
    const ev = queue.shift()!;
    done++;
    if (ev.kind === 'done') {
      yield {
        type: 'item_done',
        item: ev.item,
        index: ev.index,
        result: ev.result,
        progress: done / items.length,
      };
    } else {
      yield {
        type: 'item_error',
        item: ev.item,
        index: ev.index,
        error: ev.error,
        progress: done / items.length,
      };
    }
  }

  await allDone;
  if (errored) throw errored;
  if (collect) {
    // Soft-cancel: synthesize AbortError slots for items that were never
    // started (or whose runner exited via the in-loop signal check before
    // recording a result).
    const filled =
      signal?.aborted
        ? fillAbortedSlots(results as Array<FanOutResult<TResult> | undefined>, items.length, signal)
        : (results as FanOutResult<TResult>[]);
    yield { type: 'done_collected', results: filled };
  } else {
    yield { type: 'done', results: results as TResult[] };
  }
}

/**
 * Soft-cancel helper: fills any undefined slots in a collect-mode results
 * array with synthetic { ok: false, error } AbortError entries so the
 * returned array stays position-stable with the input items array.
 *
 * Items that were already recorded (whether { ok: true } or { ok: false }
 * from a real runner error) are preserved. Items that never ran — either
 * because the cursor never reached them or because the runner exited via
 * the in-loop signal check before writing — get a synthetic slot.
 */
function fillAbortedSlots<TResult>(
  partial: Array<FanOutResult<TResult> | undefined>,
  total: number,
  signal: AbortSignal,
): FanOutResult<TResult>[] {
  const abortErr = signalAbortError(signal);
  const out: FanOutResult<TResult>[] = new Array(total);
  for (let i = 0; i < total; i++) {
    out[i] = partial[i] ?? { ok: false, error: abortErr };
  }
  return out;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e));
}

function signalAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}
