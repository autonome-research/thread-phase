/**
 * Stress angle: RESOURCES
 *
 * Push payload sizes, nesting depth, and long-running phases to limits while
 * interacting with cancellation, malformed inputs, and dispatch patterns.
 * Each test pins a specific contract or surfaces a specific soft spot.
 *
 * Failures here ARE findings — do not "fix" them by softening the assertion.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseJSON } from '../src/agent/parse-json.js';
import { runPipeline } from '../src/orchestrator.js';
import { PipelineCache } from '../src/cache.js';
import { subPipelineOf } from '../src/patterns/sub-pipeline.js';
import { match } from '../src/patterns/match.js';
import { whileCondition } from '../src/patterns/while-condition.js';
import { withRetry } from '../src/patterns/with-retry.js';
import { parallelPhases } from '../src/patterns/parallel-phases.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  marker?: string;
  log?: string[];
  observedSignal?: AbortSignal;
  observedCacheSize?: number;
}

const makeCtx = (): Ctx => ({ cache: new PipelineCache(), log: [] });

async function collect(gen: AsyncGenerator<PipelineEvent>): Promise<PipelineEvent[]> {
  const out: PipelineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain pending microtasks N times — useful to let in-flight async work
 *  reach a known checkpoint without resorting to wall-clock timers. */
async function drainMicrotasks(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// parseJSON — adversarial payloads
// ---------------------------------------------------------------------------

describe('parseJSON: adversarial payloads', () => {
  it('returns fallback on a ~5MB truncated braced payload', () => {
    // Build payload: opens with '{', loads of nested-looking JSON, NO closing brace.
    const piece = '"k' + 'x'.repeat(50) + '":"' + 'x'.repeat(100) + '",';
    const body = piece.repeat(50_000);
    const payload = '{' + body; // intentionally truncated — no closing }
    expect(payload.length).toBeGreaterThan(5_000_000);

    const fallback = { fallback: true } as const;
    const onError = vi.fn();
    const result = parseJSON(payload, fallback, onError);

    // Contract: parseJSON returns the fallback, reports via onError once,
    // and the preview is bounded. The 10s test timeout is the only ceiling
    // for "completed at all" — no wall-clock assertion inside.
    expect(result).toBe(fallback);
    expect(onError).toHaveBeenCalledTimes(1);
    const [preview] = onError.mock.calls[0]!;
    expect(typeof preview).toBe('string');
    expect((preview as string).length).toBeLessThanOrEqual(200);
  }, 10_000);

  it('returns fallback (not RangeError) on deeply nested object ~50k levels', () => {
    const depth = 50_000;
    const payload = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);

    const fallback = { fallback: true } as const;
    const onError = vi.fn();

    let result: unknown;
    let threw: unknown = undefined;
    try {
      result = parseJSON(payload, fallback, onError);
    } catch (e) {
      threw = e;
    }

    // Contract: parseJSON must NEVER throw — it always returns fallback on bad input.
    expect(threw).toBeUndefined();
    expect(result).toBe(fallback);
    expect(onError).toHaveBeenCalledTimes(1);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// subPipeline — deep nesting, cache isolation, signal propagation
// ---------------------------------------------------------------------------

describe('subPipeline: deep nesting + cache isolation + signal propagation', () => {
  it('isolates caches at depth 50 and propagates outer signal to innermost', async () => {
    const outerController = new AbortController();
    let innermostCacheSize = -1;
    let innermostSignal: AbortSignal | undefined = undefined;

    const innermost: Phase<Ctx> = {
      name: 'innermost',
      async *run(ctx) {
        innermostCacheSize = ctx.cache.size;
        innermostSignal = ctx.signal;
        // pollute the inner cache; subPipeline should isolate it
        ctx.cache.set('inner-key', 'inner-val');
        yield { type: 'phase', phase: 'innermost' };
      },
    };

    // Build a 50-level chain by wrapping innermost in subPipelineOf 50 times.
    let current: Phase<Ctx> = innermost;
    const DEPTH = 50;
    for (let i = 0; i < DEPTH; i++) {
      const inner = current;
      const innerSpec = { phases: [inner], ctx: makeCtx() };
      current = subPipelineOf<Ctx, Ctx>(`level-${i}`, innerSpec);
    }

    const outerCtx: Ctx = makeCtx();
    // Pre-populate outer cache so isolation has something to fail on.
    outerCtx.cache.set('outer-key', 'outer-val');

    const events = await collect(
      runPipeline([current], outerCtx, { signal: outerController.signal }),
    );

    // Innermost should have seen a fresh, empty inner cache (cache isolation).
    expect(innermostCacheSize).toBe(0);
    // Innermost should have seen the outer signal (signal propagation).
    expect(innermostSignal).toBe(outerController.signal);
    // Outer cache should still only have its own key (cleared by orchestrator
    // finally — actually let's check pre-finally state via event count).
    expect(events.at(-1)).toEqual({ type: 'done' });
  });
});

// ---------------------------------------------------------------------------
// runPipeline + long-running phase — between-phase signal check vs in-phase
// ---------------------------------------------------------------------------

describe('runPipeline: signal propagation + mid-phase observation', () => {
  it('orchestrator assigns options.signal onto ctx.signal so phases can observe abort', async () => {
    const controller = new AbortController();
    let observedInsideSignal: AbortSignal | undefined = 'sentinel' as unknown as AbortSignal;

    const probe: Phase<Ctx> = {
      name: 'probe',
      async *run(ctx) {
        observedInsideSignal = ctx.signal;
        yield { type: 'phase', phase: 'probe' };
      },
    };

    await collect(runPipeline([probe], makeCtx(), { signal: controller.signal }));

    // Contract: phases that observe ctx.signal see the caller's signal.
    // Wired at orchestrator.ts:57.
    expect(observedInsideSignal).toBe(controller.signal);
  });

  it('a phase that does not observe signal keeps running after abort fires', async () => {
    const controller = new AbortController();
    const phaseStarted = defer<void>();
    const release = defer<void>();
    let secondYieldReached = false;

    const slow: Phase<Ctx> = {
      name: 'slow',
      async *run() {
        yield { type: 'phase', phase: 'slow' };
        phaseStarted.resolve();
        // Block on an external release rather than wall-clock — the test
        // owns when the phase completes, so the only thing we're observing
        // is "did abort kill it mid-phase?"
        await release.promise;
        secondYieldReached = true;
        yield { type: 'phase', phase: 'slow-done' };
      },
    };

    const runPromise = collect(
      runPipeline([slow], makeCtx(), { signal: controller.signal }),
    );

    // Wait for the phase to be parked on `release` before aborting.
    await phaseStarted.promise;
    controller.abort('mid-phase');
    // Give microtasks a chance to fire any aborted-related work.
    await drainMicrotasks();

    // Despite abort, the phase has NOT advanced past the release barrier —
    // the orchestrator does not force-cancel a running phase.
    expect(secondYieldReached).toBe(false);

    // Release the phase. Its own code can finish, but the orchestrator checks
    // cancellation before checkpoint/done and rejects rather than reporting success.
    release.resolve();
    await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondYieldReached).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// whileCondition — predicate ignores abort, runaway loop
// ---------------------------------------------------------------------------

describe('whileCondition: outer orchestrator enforces cancellation after composite phase', () => {
  it('never reports success after the outer signal aborts', async () => {
    const controller = new AbortController();
    const MAX = 5;
    let iterations = 0;

    const body: Phase<Ctx> = {
      name: 'body',
      async *run() {
        iterations++;
        if (iterations === 1) {
          // Abort during the first iteration — well before maxIterations.
          controller.abort('please-stop');
        }
        yield { type: 'phase', phase: 'body' };
      },
    };

    const loop = whileCondition<Ctx>('forever', {
      predicate: async () => true,
      body: [body],
      maxIterations: MAX,
    });

    await expect(
      collect(runPipeline([loop], makeCtx(), { signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // The composite pattern is still responsible for prompt mid-loop abort
    // checks, but the outer orchestrator cannot emit a successful done frame.
    expect(iterations).toBe(MAX);
  });
});

// ---------------------------------------------------------------------------
// match — selector returns unknown key, no default, silent skip
// ---------------------------------------------------------------------------

describe('match: typo in selector return silently no-ops', () => {
  it('emits taken=skip, runs no case, lets downstream phase still run', async () => {
    const phaseA = vi.fn();
    const phaseB = vi.fn();

    const caseA: Phase<Ctx> = {
      name: 'caseA',
      async *run() {
        phaseA();
        yield { type: 'phase', phase: 'caseA' };
      },
    };
    const caseB: Phase<Ctx> = {
      name: 'caseB',
      async *run() {
        phaseB();
        yield { type: 'phase', phase: 'caseB' };
      },
    };

    const m = match<Ctx, 'foo' | 'bar'>('route', {
      // Selector returns a key NOT in cases and there is no default.
      selector: () => 'nonexistent_key' as 'foo' | 'bar',
      cases: { foo: [caseA], bar: [caseB] },
    });

    const downstream: Phase<Ctx> = {
      name: 'downstream',
      async *run(ctx) {
        ctx.marker = 'downstream-ran';
        yield { type: 'phase', phase: 'downstream' };
      },
    };

    const ctx = makeCtx();
    const events = await collect(runPipeline([m, downstream], ctx));

    expect(phaseA).not.toHaveBeenCalled();
    expect(phaseB).not.toHaveBeenCalled();
    expect(ctx.marker).toBe('downstream-ran');

    const matchTaken = events.find(
      (e) => e.type === 'data' && e.key === 'route.taken',
    );
    expect(matchTaken).toBeDefined();
    expect((matchTaken as { value: { taken: string } }).value.taken).toBe('skip');

    // No error events.
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parallel-phases — unbounded queue under producer/consumer imbalance
// ---------------------------------------------------------------------------

describe('parallelPhases: drains all events under producer/consumer imbalance', () => {
  it('every event from every producer reaches the consumer with no drops', async () => {
    const PER = 5_000; // 4 * 5_000 = 20k events. Sufficient to exercise the queue.
    const producer = (id: number): Phase<Ctx> => ({
      name: `producer-${id}`,
      async *run() {
        for (let i = 0; i < PER; i++) {
          yield { type: 'content', content: `p${id}-${i}` };
        }
      },
    });

    const composite = parallelPhases<Ctx>('fanout', [
      producer(0),
      producer(1),
      producer(2),
      producer(3),
    ]);

    // Slow consumer: yields a microtask every 1000 events so producers
    // fan out ahead. The drain assertion is what matters; heap measurements
    // are environment-sensitive and intentionally not asserted here.
    let drained = 0;
    for await (const _ev of composite.run(makeCtx())) {
      drained++;
      if (drained % 1000 === 0) await Promise.resolve();
    }

    expect(drained).toBe(4 * PER);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// withRetry — sleep() not signal-aware, dangling timer on abort
// ---------------------------------------------------------------------------

describe('withRetry: sleep is AbortSignal-aware', () => {
  it('surfaces cancellation cooperatively mid-backoff (no wall-clock wait)', async () => {
    const controller = new AbortController();
    const onRetry = vi.fn();
    let attempts = 0;

    const flaky: Phase<Ctx> = {
      name: 'flaky',
      async *run() {
        attempts++;
        yield { type: 'phase', phase: `attempt-${attempts}` };
        throw new Error(`fail #${attempts}`);
      },
    };

    // Outsize baseDelay: if abortableSleep weren't honoring the signal,
    // the test would hang at the 5s timeout — a clean deterministic failure
    // signal instead of a flaky timing assertion.
    const wrapped = withRetry<Ctx>(flaky, {
      maxAttempts: 3,
      baseDelayMs: 60_000,
      onRetry,
      isFailure: () => true,
    });

    const runPromise = collect(
      runPipeline([wrapped], makeCtx(), { signal: controller.signal }),
    );

    // Drain microtasks so attempt 1 reaches its abortable backoff window.
    // onRetry firing exactly once confirms we're parked in the sleep.
    await drainMicrotasks();
    expect(onRetry).toHaveBeenCalledTimes(1);

    controller.abort('user-cancelled');
    await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  }, 5_000);
});
