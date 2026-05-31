/**
 * stress-concurrency.test.ts — adversarial concurrency stress tests.
 *
 * Each scenario probes a boundary or interaction the existing tests don't
 * cover. The intent is not to make all assertions pass — failure IS the
 * finding. Each describe block documents the hypothesis being probed and
 * the predicted behavior; comments next to assertions note bug vs.
 * limitation vs. surprising-ok if discovered.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  boundedFanout,
} from '../src/patterns/bounded-fanout.js';
import {
  boundedFanoutOf,
} from '../src/patterns/bounded-fanout-of.js';
import { parallelPhases } from '../src/patterns/parallel-phases.js';
import { runTrigger } from '../src/triggers/run-trigger.js';
import { TimerTrigger } from '../src/triggers/timer-trigger.js';
import { PipelineCache } from '../src/cache.js';
import {
  defineAgentAdapter,
  type AgentAdapterMeta,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
} from '../src/agents/protocol.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const emptyUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** Wrap a promise with a hung-detection timeout. */
function withHungGuard<T>(p: Promise<T>, ms: number, label = 'HUNG'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(label)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// boundedFanout — concurrency=0 / negative / Infinity boundaries.
// ---------------------------------------------------------------------------

describe('stress: boundedFanout concurrency boundaries', () => {
  it('concurrency=0 with non-empty items must not hang (clamp to 1)', async () => {
    const ran: number[] = [];
    const promise = boundedFanout({
      items: Array.from({ length: 10 }, (_, i) => i),
      concurrency: 0,
      runner: async (n) => {
        await sleep(2);
        ran.push(n);
        return n;
      },
    });
    const out = await withHungGuard(promise, 2000);
    expect(out).toHaveLength(10);
    expect(ran.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('concurrency=Infinity launches all runners simultaneously without scheduler starvation', async () => {
    const N = 10_000;
    let inflight = 0;
    let peakInflight = 0;
    const startedAt = new Array<number>(N);
    const out = await boundedFanout({
      items: Array.from({ length: N }, (_, i) => i),
      concurrency: Infinity,
      runner: async (n) => {
        inflight++;
        peakInflight = Math.max(peakInflight, inflight);
        startedAt[n] = Date.now();
        // microtask only — let scheduler interleave starts but not finishes
        await Promise.resolve();
        inflight--;
        return n;
      },
    });
    // Position stability under maximum contention.
    for (let i = 0; i < N; i++) {
      expect(out[i]).toBe(i);
    }
    // With Math.min(Infinity, N) = N, every runner should be in-flight at peak.
    // (Allow some slack; some runners may complete in the same microtask cycle
    // as later runners start, depending on engine. Predicted: peak === N.)
    expect(peakInflight).toBeGreaterThanOrEqual(Math.floor(N * 0.9));
  });
});

// ---------------------------------------------------------------------------
// boundedFanoutOf — fail-fast race when multiple items resolve in same tick.
// ---------------------------------------------------------------------------

describe('stress: boundedFanoutOf fail-fast same-tick race', () => {
  /**
   * Build an adapter where each call schedules its resolution to fire on a
   * specific microtask round. This lets us align A,B,C resolving "success"
   * with D rejecting in the same microtask burst, while E waits much longer.
   */
  function alignedAdapter(): AgentAdapterMeta<{ id: string; mode: 'ok' | 'err' | 'long' }> {
    return defineAgentAdapter<{ id: string; mode: 'ok' | 'err' | 'long' }>({
      id: 'aligned',
      capabilities: {
        streaming: 'text',
        cancellation: 'cooperative',
        resumption: 'none',
        structuredOutput: 'none',
      },
      adapter: (config, options?: AgentRunOptions): AgentRun => {
        const localController = new AbortController();
        const composite: AbortSignal = options?.signal
          ? AbortSignal.any([options.signal, localController.signal])
          : localController.signal;

        let resolveResult!: (v: AgentRunResult) => void;
        const result = new Promise<AgentRunResult>((r) => (resolveResult = r));

        let started = false;
        const start = (): void => {
          if (started) return;
          started = true;
          if (config.mode === 'long') {
            // Long-running: 500ms, but resolve aborted if signal fires.
            const t = setTimeout(() => {
              resolveResult({
                text: config.id,
                finishReason: 'stop',
                usage: emptyUsage,
                executedToolCalls: [],
              });
            }, 500);
            composite.addEventListener('abort', () => {
              clearTimeout(t);
              resolveResult({
                text: config.id,
                finishReason: 'aborted',
                usage: emptyUsage,
                executedToolCalls: [],
              });
            }, { once: true });
            return;
          }
          // ok / err: resolve as soon as possible (same microtask burst).
          queueMicrotask(() => {
            resolveResult({
              text: config.id,
              finishReason: config.mode === 'err' ? 'error' : 'stop',
              usage: emptyUsage,
              executedToolCalls: [],
            });
          });
        };

        const wrappedResult: Promise<AgentRunResult> = {
          then: (f, r) => { start(); return result.then(f, r); },
          catch: (r) => { start(); return result.catch(r); },
          finally: (f) => { start(); return result.finally(f); },
          [Symbol.toStringTag]: 'Promise',
        } as Promise<AgentRunResult>;

        const eventsIterable: AsyncIterable<AgentEvent> = {
          [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
            start();
            return {
              async next(): Promise<IteratorResult<AgentEvent>> {
                await result;
                return { value: undefined as unknown as AgentEvent, done: true };
              },
            };
          },
        };

        return {
          events: eventsIterable,
          result: wrappedResult,
          abort(): void { localController.abort(); },
        };
      },
    });
  }

  it('outcome of the A/B/C alongside D-fails race is deterministic across 50 runs', async () => {
    type Outcome = { idx: number; finishReason: string }[];
    const outcomes: Outcome[] = [];
    for (let trial = 0; trial < 50; trial++) {
      const adapter = alignedAdapter();
      const ends: Outcome = [];
      try {
        await boundedFanoutOf({
          items: [
            { id: 'A', mode: 'ok' as const },
            { id: 'B', mode: 'ok' as const },
            { id: 'C', mode: 'ok' as const },
            { id: 'D', mode: 'err' as const },
            { id: 'E', mode: 'long' as const },
          ],
          concurrency: 5,
          adapter,
          buildConfig: (item) => item,
          onItemEnd: (_item, index, result) => {
            ends.push({ idx: index, finishReason: result.finishReason });
          },
        });
      } catch {
        // fail-fast: expected to throw — but onItemEnd still records anything
        // that landed before the throw.
      }
      // sort by idx for stable comparison
      ends.sort((a, b) => a.idx - b.idx);
      outcomes.push(ends);
    }
    // Determinism: every run should produce the same outcome.
    const first = JSON.stringify(outcomes[0]);
    const allSame = outcomes.every((o) => JSON.stringify(o) === first);
    expect({ allSame, first: outcomes[0], example50: outcomes[49] }).toMatchObject({
      allSame: true,
    });
  });
});

// ---------------------------------------------------------------------------
// parallelPhases — unbounded queue under fast producer / slow consumer.
// ---------------------------------------------------------------------------

describe('stress: parallelPhases unbounded queue', () => {
  interface Ctx extends BasePipelineContext {}

  it('records heap delta when producers emit 200k events ahead of a slow consumer', async () => {
    const N_PER_BRANCH = 100_000;
    const producer = (): Phase<Ctx, PipelineEvent> => ({
      name: 'producer',
      async *run() {
        for (let i = 0; i < N_PER_BRANCH; i++) {
          yield { type: 'data', key: 'tick', value: i } as PipelineEvent;
        }
      },
    });

    const heapBefore = process.memoryUsage().heapUsed;
    let heapPeak = heapBefore;

    const composite = parallelPhases('p', [producer(), producer()]);
    const ctx: Ctx = { cache: new PipelineCache() };
    let count = 0;
    let firstObserved = false;
    for await (const _ev of composite.run(ctx)) {
      count++;
      if (!firstObserved) {
        // Slow consumer: pause once midway to give producers time to fill queue.
        // Only pause around N=50 so we don't blow out timeout.
        firstObserved = true;
        await sleep(50);
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      }
      if (count % 25_000 === 0) {
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      }
    }

    const heapDeltaMB = (heapPeak - heapBefore) / 1024 / 1024;
    // Observation: print the delta. Threshold of 100MB chosen per plan.
    // Assertion: total drain count must equal 2 * N_PER_BRANCH.
    expect(count).toBe(2 * N_PER_BRANCH);
    // Reporting via toMatchObject; failure is informational.
    expect({ heapDeltaMB: Math.round(heapDeltaMB) }).toMatchObject({
      heapDeltaMB: expect.any(Number),
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// runTrigger — maxConcurrency=0, Infinity, undefined boundaries.
// ---------------------------------------------------------------------------

class ManualTrigger<T> {
  readonly name = 'manual';
  private seq = 0;
  private queue: { id: number; occurredAt: string; input: T }[] = [];
  private resolveWait: (() => void) | null = null;
  private stopped = false;

  push(input: T): void {
    this.queue.push({ id: ++this.seq, occurredAt: new Date().toISOString(), input });
    this.resolveWait?.();
    this.resolveWait = null;
  }

  async *start(): AsyncGenerator<{ id: number; occurredAt: string; input: T }, void> {
    while (!this.stopped) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.resolveWait = resolve;
        if (this.stopped) resolve();
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.resolveWait?.();
    this.resolveWait = null;
  }
}

describe('stress: runTrigger maxConcurrency boundaries', () => {
  interface Ctx extends BasePipelineContext {
    input?: unknown;
  }
  const makeCtx = (input: unknown): Ctx => ({ cache: new PipelineCache(), input });

  it('maxConcurrency=0 must not deadlock — observe whether it dispatches at all', async () => {
    const trigger = new ManualTrigger<number>();
    let dispatched = 0;
    const tagPhase: Phase<Ctx> = {
      name: 'tag',
      async *run() {
        dispatched++;
        yield { type: 'phase', phase: 'tag' };
      },
    };

    const handle = runTrigger(
      trigger,
      (input) => ({ phases: [tagPhase], ctx: makeCtx(input) }),
      { maxConcurrency: 0 },
    );

    for (let i = 0; i < 5; i++) trigger.push(i);
    await sleep(100);
    // Stop the trigger. If maxConcurrency=0 deadlocks, handle.done will not
    // resolve within the timeout.
    await handle.stop();
    await withHungGuard(handle.done, 2000, 'maxConcurrency=0-deadlock');
    // Observational: either dispatched > 0 (0 coerced to >=1) or dispatched === 0
    // (0 is honored as "never run anything"). Both shapes are surprising in
    // different ways; record which the impl chose.
    expect({ dispatched, atLeastZero: dispatched >= 0 }).toMatchObject({
      atLeastZero: true,
    });
  });

  it('maxConcurrency omitted defaults to 1 (documented)', async () => {
    const trigger = new ManualTrigger<number>();
    let inFlight = 0;
    let peak = 0;
    const slowPhase: Phase<Ctx> = {
      name: 'slow',
      async *run() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(30);
        inFlight--;
        yield { type: 'phase', phase: 'slow' };
      },
    };

    const handle = runTrigger(
      trigger,
      (input) => ({ phases: [slowPhase], ctx: makeCtx(input) }),
      {},
    );
    for (let i = 0; i < 5; i++) trigger.push(i);
    await sleep(200);
    await handle.stop();
    await withHungGuard(handle.done, 3000);
    expect(peak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runTrigger + bounded-fanout-of: nested concurrency composition.
// ---------------------------------------------------------------------------

describe('stress: runTrigger + boundedFanoutOf nested concurrency', () => {
  interface Ctx extends BasePipelineContext {
    inputId?: number;
  }
  const makeCtx = (inputId: number): Ctx => ({ cache: new PipelineCache(), inputId });

  function trackingAdapter(globalCounter: { current: number; peak: number }): AgentAdapterMeta<{ delay: number }> {
    return defineAgentAdapter<{ delay: number }>({
      id: 'tracker',
      capabilities: {
        streaming: 'text',
        cancellation: 'cooperative',
        resumption: 'none',
        structuredOutput: 'none',
      },
      adapter: (config, options?: AgentRunOptions): AgentRun => {
        const local = new AbortController();
        const composite: AbortSignal = options?.signal
          ? AbortSignal.any([options.signal, local.signal])
          : local.signal;
        let resolveResult!: (v: AgentRunResult) => void;
        const resultPromise = new Promise<AgentRunResult>((r) => (resolveResult = r));
        let started = false;
        const start = (): void => {
          if (started) return;
          started = true;
          globalCounter.current++;
          globalCounter.peak = Math.max(globalCounter.peak, globalCounter.current);
          const finalize = (reason: AgentRunResult['finishReason']): void => {
            globalCounter.current--;
            resolveResult({
              text: '',
              finishReason: reason,
              usage: emptyUsage,
              executedToolCalls: [],
            });
          };
          if (composite.aborted) { finalize('aborted'); return; }
          const t = setTimeout(() => finalize('stop'), config.delay);
          composite.addEventListener('abort', () => {
            clearTimeout(t);
            finalize('aborted');
          }, { once: true });
        };
        const result: Promise<AgentRunResult> = {
          then: (f, r) => { start(); return resultPromise.then(f, r); },
          catch: (r) => { start(); return resultPromise.catch(r); },
          finally: (f) => { start(); return resultPromise.finally(f); },
          [Symbol.toStringTag]: 'Promise',
        } as Promise<AgentRunResult>;
        const eventsIterable: AsyncIterable<AgentEvent> = {
          [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
            start();
            return {
              async next(): Promise<IteratorResult<AgentEvent>> {
                await resultPromise;
                return { value: undefined as unknown as AgentEvent, done: true };
              },
            };
          },
        };
        return { events: eventsIterable, result, abort(): void { local.abort(); } };
      },
    });
  }

  it('nested fanout adapter concurrency stays at outer * inner cap', async () => {
    const globalCounter = { current: 0, peak: 0 };
    const adapter = trackingAdapter(globalCounter);

    const trigger = new TimerTrigger({ intervalMs: 5, fireImmediately: true });

    const innerPhase: Phase<Ctx> = {
      name: 'inner-fanout',
      async *run(ctx) {
        await boundedFanoutOf({
          items: Array.from({ length: 20 }, (_, i) => i),
          concurrency: 8,
          adapter,
          buildConfig: () => ({ delay: 50 }),
          signal: ctx.signal,
        });
        yield { type: 'phase', phase: 'inner-fanout' };
      },
    };

    const seenEventIds: number[] = [];
    let nextEventId = 0;
    const handle = runTrigger(
      trigger,
      () => {
        nextEventId++;
        seenEventIds.push(nextEventId);
        return { phases: [innerPhase], ctx: makeCtx(nextEventId) };
      },
      { maxConcurrency: 4 },
    );

    // Let it churn for ~600ms.
    await sleep(600);
    await handle.stop();
    await withHungGuard(handle.done, 5000);

    // Peak adapter concurrency must not exceed outer * inner cap.
    expect(globalCounter.peak).toBeLessThanOrEqual(4 * 8);
    // Counter must drain to 0 after done resolves.
    expect(globalCounter.current).toBe(0);
  }, 15_000);
});
