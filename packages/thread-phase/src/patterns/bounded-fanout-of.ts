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
 * @internal — exported via thread-phase/patterns
 */

import type {
  AgentAdapterMeta,
  AgentEventBus,
  AgentRun,
  AgentRunResult,
} from '../agents/protocol.js';

/** Per-item failure handling. Mirrors boundedFanout's mode. @internal */
export type BoundedFanoutOfMode = 'fail-fast' | 'collect';

/** @internal */
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
  /** Default 'fail-fast'. */
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
 *
 * @internal
 */
export async function boundedFanoutOf<TItem, TConfig>(
  opts: BoundedFanoutOfOptions<TItem, TConfig>,
): Promise<AgentRunResult[]> {
  const items = opts.items;
  if (items.length === 0) return [];

  const concurrency = Math.max(1, Math.min(opts.concurrency, items.length));
  const mode: BoundedFanoutOfMode = opts.mode ?? 'fail-fast';
  const results: Array<AgentRunResult | undefined> = new Array(items.length);

  // Track every in-flight adapter run so fail-fast can abort them all in
  // one pass. The entry holds the per-item controller (used to compose the
  // adapter's signal via AbortSignal.any), the run handle itself (used to
  // call abort() — belt-and-suspenders since the composite signal already
  // covers it, but adapters may key off abort() rather than the signal),
  // and the run's `result` promise so we can await adapter cleanup before
  // resolving the fanout. Without that await, fail-fast resolves while
  // adapter handles are still finalizing.
  interface InFlight {
    controller: AbortController;
    run: AgentRun;
    result: Promise<AgentRunResult>;
  }
  const inFlight = new Set<InFlight>();

  type FailedRecord = { index: number; result: AgentRunResult };
  let failed: FailedRecord | null = null;
  let cursor = 0;

  const abortAllInFlight = async (): Promise<void> => {
    const snapshot = [...inFlight];
    for (const entry of snapshot) {
      entry.controller.abort();
      entry.run.abort('boundedFanoutOf fail-fast');
    }
    // Wait for every aborted run's `result` to settle so adapter-side cleanup
    // (timers, sockets, subprocesses) finishes before the fanout returns.
    // We allSettled because the runs may reject as `aborted` and we don't
    // want to mask the original failure with the abort-induced one.
    await Promise.allSettled(snapshot.map((e) => e.result));
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (failed) return;
      if (opts.signal?.aborted) return;
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;

      const itemController = new AbortController();
      const compositeSignal: AbortSignal = opts.signal
        ? AbortSignal.any([opts.signal, itemController.signal])
        : itemController.signal;

      const config = opts.buildConfig(item, i);
      const run = opts.adapter.adapter(config, {
        signal: compositeSignal,
        eventBus: opts.eventBus,
        traceId: opts.traceId,
      });

      const entry: InFlight = { controller: itemController, run, result: run.result };
      inFlight.add(entry);

      // The adapter's events iterable is intentionally NOT consumed here.
      // The event bus is the multi-subscriber seam; double-iteration would
      // break the single-consumer invariant. Awaiting `result` is sufficient
      // to start lazy adapters.
      let result: AgentRunResult;
      try {
        result = await run.result;
      } finally {
        inFlight.delete(entry);
      }

      if (result.finishReason === 'error') {
        if (mode === 'fail-fast') {
          if (!failed) {
            failed = { index: i, result };
            opts.onItemError?.(item, i, result);
            await abortAllInFlight();
          }
          return;
        }
        // collect: store and keep going.
        results[i] = result;
        opts.onItemEnd?.(item, i, result);
        continue;
      }

      results[i] = result;
      opts.onItemEnd?.(item, i, result);
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  if (failed) {
    const f: FailedRecord = failed;
    throw new BoundedFanoutOfError(f.index, f.result);
  }

  // collect mode may still have undefined slots if the outer signal aborted
  // before some items were dispatched. Adapters honoring `compositeSignal`
  // produce `finishReason: 'aborted'` results for items that started post-
  // abort; items that never started leave the slot undefined. Fill those
  // with a synthetic aborted result so the returned array stays position-
  // stable with the input items array.
  if (opts.signal?.aborted) {
    for (let i = 0; i < items.length; i++) {
      if (results[i] === undefined) {
        results[i] = syntheticAbortedResult();
      }
    }
  }

  return results as AgentRunResult[];
}

/** @internal */
export class BoundedFanoutOfError extends Error {
  constructor(
    public itemIndex: number,
    public result: AgentRunResult,
  ) {
    super(`boundedFanoutOf failed at item ${itemIndex}: ${result.finishReason}`);
    this.name = 'BoundedFanoutOfError';
  }
}

function syntheticAbortedResult(): AgentRunResult {
  return {
    text: '',
    finishReason: 'aborted',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    executedToolCalls: [],
  };
}
