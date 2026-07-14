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

export type FanOutResult<TResult> =
  | { ok: true; value: TResult }
  | { ok: false; error: Error };

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
  if (
    options.maxItems !== undefined &&
    (!Number.isSafeInteger(options.maxItems) || options.maxItems < 0)
  ) {
    throw new RangeError('boundedFanout maxItems must be a non-negative safe integer');
  }
  const requestedConcurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1) {
    throw new RangeError('boundedFanout concurrency must be a positive safe integer');
  }

  const items =
    options.maxItems !== undefined ? options.items.slice(0, options.maxItems) : options.items;
  if (items.length === 0) return [];

  const concurrency = Math.min(requestedConcurrency, items.length);
  const collect = options.mode === 'collect';
  const results: Array<TResult | FanOutResult<TResult> | undefined> = new Array(items.length);
  let cursor = 0;
  let firstError: Error | undefined;
  const failFastController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, failFastController.signal])
    : failFastController.signal;

  if (options.signal?.aborted) {
    if (collect) return fillAbortedSlots([], items.length, options.signal);
    throw signalAbortError(options.signal);
  }

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted || firstError) return;
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        const result = await options.runner(item, i, signal);
        if (signal.aborted || firstError) return;
        if (collect) results[i] = { ok: true, value: result };
        else results[i] = result;
        options.onItemDone?.({ item, index: i, result });
      } catch (rawErr) {
        const error = toError(rawErr);
        if (collect) results[i] = { ok: false, error };
        if (!collect && !firstError && !options.signal?.aborted) {
          firstError = error;
          failFastController.abort(error);
        }
        try {
          options.onItemError?.({ item, index: i, error });
        } catch (hookError) {
          if (!firstError && !options.signal?.aborted) {
            firstError = toError(hookError);
            failFastController.abort(firstError);
          }
          return;
        }
        if (collect) continue;
        return;
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  // A fail-fast result is not exposed until all sibling workers settle.
  // The local signal asks in-flight runners to abort; runners that ignore it
  // delay rejection rather than continuing after a workflow turns terminal.
  const settlements = await Promise.allSettled(workers);
  const unexpectedWorkerFailure = settlements.find(
    (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
  );
  if (unexpectedWorkerFailure && !firstError && !options.signal?.aborted) {
    firstError = toError(unexpectedWorkerFailure.reason);
  }

  // Caller cancellation is authoritative even when sibling runners reject
  // with their own generic abort errors while unwinding.
  if (options.signal?.aborted) {
    if (collect) {
      return fillAbortedSlots(
        results as Array<FanOutResult<TResult> | undefined>,
        items.length,
        options.signal,
      );
    }
    throw signalAbortError(options.signal);
  }

  if (firstError) throw firstError;

  return results as TResult[] | FanOutResult<TResult>[];
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
