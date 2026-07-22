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

import type {
  AgentAdapterMeta,
  AgentEventBus,
  AgentRun,
  AgentRunResult,
} from '../agents/protocol.js';

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
  /** Optional shared traceId propagated into every adapter call. */
  traceId?: string;
  /**
   * Optional stable per-item trace attribution. All IDs are derived and
   * validated before any adapter is invoked; when present this overrides
   * the shared traceId for each item.
   */
  traceIdFor?: (item: TItem, index: number) => string;
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
export async function boundedFanoutOf<TItem, TConfig>(
  opts: BoundedFanoutOfOptions<TItem, TConfig>,
): Promise<AgentRunResult[]> {
  const items = opts.items;
  if (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new RangeError('boundedFanoutOf concurrency must be a positive safe integer');
  }
  if (items.length === 0) return [];

  const traceIds = resolveTraceIds(items, opts.traceIdFor);
  const concurrency = Math.min(opts.concurrency, items.length);
  const mode: BoundedFanoutOfMode = opts.mode ?? 'fail-fast';
  const results: Array<AgentRunResult | undefined> = new Array(items.length);

  interface InFlight {
    controller: AbortController;
    run: AgentRun;
    result: Promise<AgentRunResult>;
  }
  const inFlight = new Set<InFlight>();
  let firstFailure: Error | undefined;
  let cursor = 0;

  const abortAndSettle = async (): Promise<void> => {
    const snapshot = [...inFlight];
    for (const entry of snapshot) {
      entry.controller.abort(firstFailure);
      entry.run.abort('boundedFanoutOf fail-fast');
    }
    await Promise.allSettled(snapshot.map((entry) => entry.result));
  };

  const fail = async (error: unknown): Promise<void> => {
    if (firstFailure) return;
    firstFailure = error instanceof Error ? error : new Error(String(error));
    await abortAndSettle();
  };

  const worker = async (): Promise<void> => {
    while (!firstFailure && !opts.signal?.aborted) {
      const i = cursor++;
      if (i >= items.length) return;
      const item = items[i]!;
      try {
        const itemController = new AbortController();
        const compositeSignal = opts.signal
          ? AbortSignal.any([opts.signal, itemController.signal])
          : itemController.signal;
        const config = opts.buildConfig(item, i);
        const run = opts.adapter.adapter(config, {
          signal: compositeSignal,
          eventBus: opts.eventBus,
          traceId: traceIds?.[i] ?? opts.traceId,
        });
        const entry: InFlight = { controller: itemController, run, result: run.result };
        inFlight.add(entry);

        let result: AgentRunResult;
        try {
          result = await run.result;
        } finally {
          inFlight.delete(entry);
        }

        if (result.finishReason === 'error' && mode === 'fail-fast') {
          const failure = new BoundedFanoutOfError(i, result);
          try { opts.onItemError?.(item, i, result); } catch { /* preserve primary failure */ }
          await fail(failure);
          return;
        }

        results[i] = result;
        opts.onItemEnd?.(item, i, result);
      } catch (error) {
        await fail(error);
        return;
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  const settlements = await Promise.allSettled(workers);
  if (!firstFailure) {
    const rejected = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
    );
    if (rejected) firstFailure = rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason));
  }

  if (opts.signal?.aborted && mode === 'fail-fast') throw signalAbortError(opts.signal);
  if (firstFailure) throw firstFailure;

  if (opts.signal?.aborted) {
    for (let i = 0; i < items.length; i++) {
      if (results[i] === undefined) results[i] = syntheticAbortedResult();
    }
  }

  return results as AgentRunResult[];
}

function resolveTraceIds<TItem>(
  items: ReadonlyArray<TItem>,
  traceIdFor: ((item: TItem, index: number) => string) | undefined,
): string[] | undefined {
  if (!traceIdFor) return undefined;
  const traceIds = items.map((item, index) => traceIdFor(item, index));
  const seen = new Set<string>();
  for (let index = 0; index < traceIds.length; index++) {
    const traceId: unknown = traceIds[index];
    if (
      typeof traceId !== 'string' ||
      traceId.trim().length === 0 ||
      /[\u0000-\u001f\u007f]/.test(traceId)
    ) {
      throw new TypeError(`boundedFanoutOf traceIdFor returned an invalid trace ID at item ${index}`);
    }
    if (seen.has(traceId)) {
      throw new Error(`boundedFanoutOf traceIdFor returned duplicate trace ID ${JSON.stringify(traceId)}`);
    }
    seen.add(traceId);
  }
  return traceIds;
}

export class BoundedFanoutOfError extends Error {
  constructor(
    public itemIndex: number,
    public result: AgentRunResult,
  ) {
    super(`boundedFanoutOf failed at item ${itemIndex}: ${result.finishReason}`);
    this.name = 'BoundedFanoutOfError';
  }
}

function signalAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'aborted');
  error.name = 'AbortError';
  return error;
}

function syntheticAbortedResult(): AgentRunResult {
  return {
    text: '',
    finishReason: 'aborted',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    executedToolCalls: [],
  };
}
