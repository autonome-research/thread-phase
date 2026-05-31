/**
 * Stress tests — cancellation angle.
 *
 * These tests probe the boundaries of cancellation across orchestrator,
 * pattern wrappers, triggers, adapters, and the JobRunner agent loop.
 * Failures here are findings (bugs/limitations), not bugs in the tests.
 */

import { describe, it, expect } from 'vitest';
import { runPipeline, runPipelineToSummary } from '../src/orchestrator.js';
import { PipelineCache } from '../src/cache.js';
import { withRetry } from '../src/patterns/with-retry.js';
import { parallelPhases } from '../src/patterns/parallel-phases.js';
import { boundedFanoutOf } from '../src/patterns/bounded-fanout-of.js';
import { TimerTrigger } from '../src/triggers/timer-trigger.js';
import { runTrigger } from '../src/triggers/run-trigger.js';
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

interface Ctx extends BasePipelineContext {
  visited?: string[];
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  try {
    for await (const e of gen) out.push(e);
  } catch (err) {
    throw err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. orchestrator never assigns options.signal to ctx.signal
// ---------------------------------------------------------------------------
describe('cancellation: orchestrator does not wire options.signal onto ctx.signal', () => {
  it('FINDING: ctx.signal stays undefined even when runPipeline is given a signal', async () => {
    const observed: { sig: AbortSignal | undefined } = { sig: undefined };
    const controller = new AbortController();
    const ctx: Ctx = { cache: new PipelineCache() };

    const peek: Phase<Ctx> = {
      name: 'peek',
      async *run(c) {
        // Phases that want mid-phase cancel are *documented* to read ctx.signal
        // (see phase.ts:38-42). Capture what they actually see.
        observed.sig = c.signal;
        yield { type: 'phase', phase: 'peek' };
      },
    };

    await collect(runPipeline([peek], ctx, { signal: controller.signal }));

    // The contract: phases observing ctx.signal should see the caller's signal.
    // Actual behaviour: orchestrator.ts:56 stores `signal` locally and never
    // writes it onto ctx — phases see `undefined`. This is the asymmetry vs
    // run-trigger.ts:127 (`ctx.signal = controller.signal`).
    expect(observed.sig).toBe(controller.signal);
  });

  it('busy phase can be interrupted via ctx.signal during a cooperative wait', async () => {
    const controller = new AbortController();
    const ctx: Ctx = { cache: new PipelineCache() };
    let abortFired = false;

    const busy: Phase<Ctx> = {
      name: 'busy',
      async *run(c) {
        c.signal?.addEventListener('abort', () => {
          abortFired = true;
        });
        yield { type: 'phase', phase: 'busy' };
        // Cooperative wait: race the timer against the signal so abort wakes
        // the phase immediately. This is the pattern phases use to honor
        // cancellation; the framework provides ctx.signal so this is possible.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 200);
          c.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      },
    };

    setTimeout(() => controller.abort('user-cancel'), 30);
    const t0 = Date.now();
    try {
      await collect(runPipeline([busy], ctx, { signal: controller.signal }));
    } catch {
      /* ignore */
    }
    const dt = Date.now() - t0;

    expect(abortFired).toBe(true);
    expect(dt).toBeLessThan(120);
  });
});

// ---------------------------------------------------------------------------
// 2. AbortError between phases emits no terminal/cancelled event
// ---------------------------------------------------------------------------
describe('cancellation: aborting between phases swallows queued events / has no cancelled event', () => {
  it('throws AbortError without emitting a terminal "done"/"cancelled" frame', async () => {
    const controller = new AbortController();
    const ctx: Ctx = { cache: new PipelineCache() };

    const a: Phase<Ctx> = {
      name: 'a',
      async *run() {
        yield { type: 'phase', phase: 'a' };
      },
    };
    const b: Phase<Ctx> = {
      name: 'b',
      async *run() {
        yield { type: 'phase', phase: 'b' };
      },
    };

    const events: PipelineEvent[] = [];
    let threw: unknown = null;
    try {
      for await (const ev of runPipeline([a, b], ctx, { signal: controller.signal })) {
        events.push(ev);
        // Abort after A emits, before B runs.
        if (ev.type === 'phase' && ev.phase === 'a') controller.abort('user-cancel');
      }
    } catch (err) {
      threw = err;
    }

    // Observation: we get A's phase event then a thrown AbortError. No terminal
    // frame describing the cancel — consumers must learn it from the rejection.
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'phase', phase: 'a' });
    expect((threw as Error | null)?.name).toBe('AbortError');

    // FINDING: no canonical { type: 'cancelled', reason } discriminant exists
    // on the PipelineEvent union (phase.ts:55-63). SSE bridges and the like
    // cannot send a final cancel frame — there is none defined.
    const cancelLike = events.find(
      (e) => (e as { type: string }).type === 'cancelled' || (e as { type: string }).type === 'done',
    );
    expect(cancelLike).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. with-retry sleep ignores AbortSignal
// ---------------------------------------------------------------------------
describe('cancellation: withRetry sleep() ignores AbortSignal', () => {
  it('outer abort during backoff waits the full delay before surfacing', { timeout: 15000 }, async () => {
    const controller = new AbortController();
    const ctx: Ctx = { cache: new PipelineCache() };
    let attempts = 0;

    const flaky: Phase<Ctx> = {
      name: 'flaky',
      async *run(c) {
        attempts++;
        yield { type: 'phase', phase: 'flaky' };
        c.stop = { reason: 'fail' };
      },
    };

    const wrapped = withRetry(flaky, {
      maxAttempts: 5,
      baseDelayMs: 400, // first backoff = 400ms; cancel mid-sleep
      isFailure: () => true,
    });

    const p = runPipelineToSummary([wrapped], ctx, { signal: controller.signal });
    // Abort after first attempt has started its backoff (~50ms after start).
    setTimeout(() => controller.abort('user'), 50);

    const t0 = Date.now();
    let result: unknown;
    try {
      result = await p;
    } catch (err) {
      result = err;
    }
    const dt = Date.now() - t0;

    // Expectation: cancellation should surface cooperatively within ~120ms.
    // sleep() in with-retry.ts:39 has no abort hook, so we expect the actual
    // duration to be ~400ms+ (failing the bound, exposing the gap).
    expect(dt).toBeLessThan(150);
    // And the retry counter shouldn't have advanced past attempt 1.
    expect(attempts).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 4. parallel-phases siblings keep running after sibling throws + no cancel
// ---------------------------------------------------------------------------
describe('cancellation: parallelPhases siblings can be cancelled cooperatively', () => {
  it('sibling that observes c.signal bails when the other branch throws; outer abort also propagates', async () => {
    const controller = new AbortController();
    const ctx: Ctx = { cache: new PipelineCache() };
    let bEmissions = 0;
    let bSawCancel = false;

    const a: Phase<Ctx> = {
      name: 'a',
      async *run() {
        await sleep(10);
        throw new Error('branch A boom');
      },
    };
    const b: Phase<Ctx> = {
      name: 'b',
      async *run(c) {
        for (let i = 0; i < 200; i++) {
          if (c.signal?.aborted) {
            bSawCancel = true;
            return;
          }
          await sleep(2);
          bEmissions++;
          yield { type: 'phase', phase: 'b', detail: String(i) };
        }
      },
    };

    const composite = parallelPhases('par', [a, b]);
    setTimeout(() => controller.abort('outer-cancel'), 20);

    const t0 = Date.now();
    try {
      await collect(runPipeline([composite], ctx, { signal: controller.signal }));
    } catch {
      /* ignore */
    }
    const dt = Date.now() - t0;

    // Contract: B emits << 200 events because either the sibling error or
    // the outer abort cut its cooperative loop short. parallelPhases composes
    // outer + internal signals via AbortSignal.any and exposes the composed
    // signal as c.signal on each branch's ctx.
    expect(bEmissions).toBeLessThan(50);
    expect(dt).toBeLessThan(150);
    expect(bSawCancel).toBe(true);
    void controller;
  });
});

// ---------------------------------------------------------------------------
// 5. boundedFanoutOf abort during fail-fast — leaked cleanup
// ---------------------------------------------------------------------------
describe('cancellation: boundedFanoutOf fail-fast awaits adapter cleanup before resolving', () => {
  it('no open adapter handles or post-settle mutations after fail-fast', async () => {
    let openHandles = 0;
    let postSettleMutations = 0;
    let resolved = false;

    interface Cfg {
      shouldFail: boolean;
    }

    const adapter: AgentAdapterMeta<Cfg> = defineAgentAdapter<Cfg>({
      id: 'leaky',
      capabilities: {
        streaming: 'final-only',
        cancellation: 'cooperative',
        resumption: 'none',
        structuredOutput: 'none',
      },
      adapter: (config: Cfg, options?: AgentRunOptions): AgentRun => {
        openHandles++;
        const local = new AbortController();
        const composite = options?.signal
          ? AbortSignal.any([options.signal, local.signal])
          : local.signal;

        let resolveResult!: (v: AgentRunResult) => void;
        const resultPromise = new Promise<AgentRunResult>((r) => (resolveResult = r));

        // Simulate a SIGTERM grace period: the adapter completes its cleanup
        // BEFORE resolving `result`. Honors the AgentRun contract that
        // run.result settles only after all in-process cleanup is finished —
        // boundedFanoutOf awaits that for leak-free shutdown. The
        // `cleanedUp` guard reflects the idempotence any real adapter must
        // provide (natural completion + abort can both call cleanup).
        let cleanedUp = false;
        const cleanup = (reason: AgentRunResult['finishReason']): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          setTimeout(() => {
            openHandles--;
            if (resolved) postSettleMutations++;
            resolveResult({
              text: '',
              finishReason: reason,
              usage: emptyUsage,
              executedToolCalls: [],
            });
          }, 250);
        };

        const t = setTimeout(() => {
          if (config.shouldFail) cleanup('error');
          else cleanup('stop');
        }, 30);
        composite.addEventListener('abort', () => {
          clearTimeout(t);
          cleanup('aborted');
        });

        return {
          events: {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  await resultPromise;
                  return { value: undefined as unknown as AgentEvent, done: true };
                },
              };
            },
          },
          result: resultPromise,
          abort() {
            local.abort();
          },
        };
      },
    });

    const promise = boundedFanoutOf({
      items: [
        { shouldFail: true },
        { shouldFail: false },
        { shouldFail: false },
        { shouldFail: false },
        { shouldFail: false },
        { shouldFail: false },
      ],
      concurrency: 3,
      adapter,
      buildConfig: (item) => item,
      mode: 'fail-fast',
    });

    try {
      await promise;
    } catch {
      /* expected: BoundedFanoutOfError */
    }
    resolved = true;

    // Contract: by the time boundedFanoutOf resolves, every aborted adapter
    // has finished its cleanup (because run.result resolves only after the
    // adapter is done) and there are zero post-settle mutations.
    expect(openHandles).toBe(0);
    await sleep(400);
    expect(postSettleMutations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. TimerTrigger payload factory hangs past trigger.stop()
// ---------------------------------------------------------------------------
describe('cancellation: TimerTrigger.stop() does not abort an in-flight payload', () => {
  it('handle.done blocks until slow payload resolves', async () => {
    const trigger = new TimerTrigger<{ x: number }>({
      intervalMs: 30,
      payload: async () => {
        // Slow payload: 600ms; stop() will fire well before this resolves.
        await sleep(600);
        return { x: 1 };
      },
    });

    const events: number[] = [];
    const handle = runTrigger(
      trigger,
      () => ({
        phases: [
          {
            name: 'noop',
            async *run() {
              events.push(1);
            },
          } as Phase<Ctx>,
        ],
        ctx: { cache: new PipelineCache() } as Ctx,
      }),
    );

    // After 100ms (timer fired once, mid-payload), stop the handle.
    setTimeout(() => void handle.stop(), 100);

    const t0 = Date.now();
    await handle.done;
    const dt = Date.now() - t0;

    // Expectation: handle.done resolves within ~200ms of stop (timer cleared,
    // no need to wait on payload). Actual: makeEvent awaits payload with no
    // race against notifyStop, so dt approaches 600ms+.
    expect(dt).toBeLessThan(250);
  });
});

// ---------------------------------------------------------------------------
// 8. Race: ctx.stop set + AbortSignal fires same tick — stop wins
// ---------------------------------------------------------------------------
describe('cancellation: ctx.stop precedence vs AbortSignal (race nondeterminism)', () => {
  it('phase that sets ctx.stop AND a same-tick abort: summary reports stopped, not cancelled', async () => {
    const controller = new AbortController();
    const ctx: Ctx = { cache: new PipelineCache() };

    const phase: Phase<Ctx> = {
      name: 'p',
      async *run(c) {
        yield { type: 'phase', phase: 'p' };
        c.stop = { reason: 'natural-stop' };
        // In the same microtask after the phase returns, the caller aborts.
        // Schedule it so it fires before the next loop iteration's check.
        queueMicrotask(() => controller.abort('user-cancel'));
      },
    };

    const summary = await runPipelineToSummary([phase], ctx, {
      signal: controller.signal,
    });

    // Observation per orchestrator.ts:67-69: ctx.stop wins because it's
    // checked AFTER the phase returns, BEFORE the next iteration's abort
    // check. So the summary reports 'stopped' with 'natural-stop' even
    // though the user requested cancellation.
    expect(summary.status).toBe('stopped');
    expect(summary.reason).toBe('natural-stop');
    // UX surprise: a caller doing `if (summary.reason === 'cancelled')` to
    // detect cancels will misclassify this as a clean stop. There is no
    // 'cancelled' discriminant on PipelineSummary either.
    expect((summary as { reason?: string }).reason).not.toBe('cancelled');
  });
});
