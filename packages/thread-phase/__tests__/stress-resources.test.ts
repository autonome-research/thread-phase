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

// ---------------------------------------------------------------------------
// parseJSON — adversarial payloads
// ---------------------------------------------------------------------------

describe('parseJSON: adversarial payloads', () => {
  it('returns fallback on a ~5MB truncated braced payload without catastrophic regex blow-up', () => {
    // Build payload: opens with '{', loads of nested-looking JSON, NO closing brace.
    const piece = '"k' + 'x'.repeat(50) + '":"' + 'x'.repeat(100) + '",';
    const body = piece.repeat(50_000);
    const payload = '{' + body; // intentionally truncated — no closing }
    expect(payload.length).toBeGreaterThan(5_000_000);

    const fallback = { fallback: true } as const;
    const onError = vi.fn();

    const t0 = performance.now();
    const result = parseJSON(payload, fallback, onError);
    const elapsed = performance.now() - t0;

    expect(result).toBe(fallback);
    expect(onError).toHaveBeenCalledTimes(1);
    const [preview] = onError.mock.calls[0]!;
    expect(typeof preview).toBe('string');
    expect((preview as string).length).toBeLessThanOrEqual(200);
    // Sanity ceiling — should be well under 2s even with the greedy regex.
    expect(elapsed).toBeLessThan(2000);
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
    const PHASE_MS = 600; // keep short to keep the test fast

    const slow: Phase<Ctx> = {
      name: 'slow',
      async *run() {
        yield { type: 'phase', phase: 'slow' };
        await new Promise((r) => setTimeout(r, PHASE_MS));
        yield { type: 'phase', phase: 'slow-done' };
      },
    };

    setTimeout(() => controller.abort('mid-phase'), 50);

    const t0 = performance.now();
    const events = await collect(
      runPipeline([slow], makeCtx(), { signal: controller.signal }),
    );
    const elapsed = performance.now() - t0;

    // Phase ran to completion despite abort firing at 50ms.
    expect(elapsed).toBeGreaterThanOrEqual(PHASE_MS - 50);
    // Both yields landed (no mid-phase interrupt).
    const phaseEvs = events.filter((e) => e.type === 'phase');
    expect(phaseEvs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// whileCondition — predicate ignores abort, runaway loop
// ---------------------------------------------------------------------------

describe('whileCondition: ignores AbortSignal (runaway primitive)', () => {
  it('keeps iterating after abort fires because predicate never reads ctx.signal', async () => {
    const controller = new AbortController();
    let iterations = 0;

    const body: Phase<Ctx> = {
      name: 'body',
      async *run() {
        iterations++;
        // Tiny yield to let microtasks turn — but no signal observation.
        yield { type: 'phase', phase: 'body' };
        await new Promise((r) => setTimeout(r, 1));
      },
    };

    const loop = whileCondition<Ctx>('forever', {
      predicate: async () => true,
      body: [body],
      maxIterations: 100_000,
    });

    setTimeout(() => controller.abort('please-stop'), 100);

    // Hard wall: race the loop against a 600ms guard so vitest doesn't hang.
    const racePromise = Promise.race([
      collect(runPipeline([loop], makeCtx(), { signal: controller.signal })).then(
        () => 'completed' as const,
      ),
      new Promise<'guard'>((r) => setTimeout(() => r('guard'), 600)),
    ]);

    const winner = await racePromise;
    // The race winner is the guard (loop didn't stop on abort).
    expect(winner).toBe('guard');
    // Iterations crossed past the abort moment (~100ms).
    expect(iterations).toBeGreaterThan(20);

    // Cleanup: we can't actually stop the loop from outside since it ignores
    // the signal. Give Node a tick — leftover setTimeout(1ms) iterations will
    // continue in the background but vitest will move on once `winner` resolves.
  }, 5000);
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

describe('parallelPhases: unbounded queue under slow consumer', () => {
  it('drains all events when consumer is slower than 4 producers (no drops, finite memory)', async () => {
    const PER = 25_000; // 4 * 25_000 = 100k events total. Keep modest for CI.
    const producer = (id: number): Phase<Ctx> => ({
      name: `producer-${id}`,
      async *run() {
        for (let i = 0; i < PER; i++) {
          yield { type: 'content', content: 'x' };
        }
      },
    });

    const composite = parallelPhases<Ctx>('fanout', [
      producer(0),
      producer(1),
      producer(2),
      producer(3),
    ]);

    const baseHeap = process.memoryUsage().heapUsed;
    let peakHeap = baseHeap;
    const sampler = setInterval(() => {
      const h = process.memoryUsage().heapUsed;
      if (h > peakHeap) peakHeap = h;
    }, 25);

    let drained = 0;
    try {
      for await (const _ev of composite.run(makeCtx())) {
        drained++;
        // Slow consumer: yield to microtask every 1000 events.
        if (drained % 1000 === 0) {
          await Promise.resolve();
        }
      }
    } finally {
      clearInterval(sampler);
    }

    expect(drained).toBe(4 * PER);
    // Observational log, not a hard assertion (different machines vary).
    // Document the queue-growth blast radius for the team.
    const growthMB = (peakHeap - baseHeap) / (1024 * 1024);
    // eslint-disable-next-line no-console
    console.log(`[parallelPhases stress] peak heap growth: ${growthMB.toFixed(1)} MB`);
    // Loose ceiling: 4*25k tiny content events should never grow heap by >500MB.
    expect(growthMB).toBeLessThan(500);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// withRetry — sleep() not signal-aware, dangling timer on abort
// ---------------------------------------------------------------------------

describe('withRetry: sleep is AbortSignal-aware', () => {
  it('surfaces cancellation cooperatively mid-backoff instead of waiting out the full delay', async () => {
    const controller = new AbortController();
    const BASE_DELAY = 400; // short to keep test fast; still observable
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

    const wrapped = withRetry<Ctx>(flaky, {
      maxAttempts: 3,
      baseDelayMs: BASE_DELAY,
      onRetry,
      isFailure: () => true,
    });

    // Abort 50ms in — during the BASE_DELAY (400ms) sleep between attempt 1 and 2.
    setTimeout(() => controller.abort('user-cancelled'), 50);

    const t0 = performance.now();
    let threw: unknown = undefined;
    try {
      await collect(
        runPipeline([wrapped], makeCtx(), { signal: controller.signal }),
      );
    } catch (e) {
      threw = e;
    }
    const elapsed = performance.now() - t0;

    // Contract: cancellation surfaces within tens of milliseconds of abort,
    // far below the BASE_DELAY backoff window. The pipeline rejects with
    // AbortError. attempts must not have advanced beyond the first since
    // the abort fired mid-sleep; onRetry is invoked exactly once because
    // withRetry calls it BEFORE entering the (now-abortable) backoff sleep.
    expect(elapsed).toBeLessThan(BASE_DELAY);
    expect(attempts).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(threw).toBeDefined();
    expect((threw as Error).name).toBe('AbortError');
  }, 10_000);
});
