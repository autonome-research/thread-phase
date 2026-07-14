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

/** Drain pending microtasks N times so awaited state machines can reach a
 *  known checkpoint without resorting to wall-clock timers. */
async function drainMicrotasks(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
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

  it('busy phase can observe ctx.signal abort and short-circuit a cooperative wait', async () => {
    const controller = new AbortController();
    const ctx: Ctx = { cache: new PipelineCache() };
    const phaseStarted = defer<void>();
    let abortFired = false;
    let waitedReleaseReason: 'abort' | 'natural' = 'natural';

    const busy: Phase<Ctx> = {
      name: 'busy',
      async *run(c) {
        c.signal?.addEventListener('abort', () => {
          abortFired = true;
        });
        yield { type: 'phase', phase: 'busy' };
        phaseStarted.resolve();
        // Cooperative wait: race a slow natural-completion timer against
        // ctx.signal. With a 60-second natural timer, the test will hang
        // out past its timeout if abort isn't honored — clean signal.
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            waitedReleaseReason = 'natural';
            resolve();
          }, 60_000);
          c.signal?.addEventListener(
            'abort',
            () => {
              waitedReleaseReason = 'abort';
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      },
    };

    const runPromise = collect(runPipeline([busy], ctx, { signal: controller.signal }));
    await phaseStarted.promise;
    controller.abort('user-cancel');
    await runPromise.catch(() => {});

    expect(abortFired).toBe(true);
    expect(waitedReleaseReason).toBe('abort');
  });
});

// ---------------------------------------------------------------------------
// 2. Aborting between phases emits a terminal 'cancelled' frame, then throws
// ---------------------------------------------------------------------------
describe('cancellation: aborting between phases yields a terminal cancelled frame before throwing', () => {
  it('for-await consumers observe {type:"cancelled",reason} as the last event; the promise still rejects with AbortError', async () => {
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

    // Contract: consumers see A's event, then the canonical cancellation
    // frame, then the for-await ends via the rejection. Both signals
    // together let SSE bridges record a clean terminal frame while
    // promise-style callers still get the AbortError rejection.
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'phase', phase: 'a' });
    expect(events[1]).toEqual({ type: 'cancelled', reason: 'user-cancel' });
    expect((threw as Error | null)?.name).toBe('AbortError');
  });
});

// ---------------------------------------------------------------------------
// 3. with-retry sleep ignores AbortSignal
// ---------------------------------------------------------------------------
describe('cancellation: withRetry sleep is AbortSignal-aware', () => {
  it('outer abort surfaces during backoff via abortableSleep — no wall-clock wait', async () => {
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

    // 60s baseDelay: if abortableSleep weren't honoring ctx.signal, the
    // test would hang at its 5s timeout — a clean deterministic failure.
    const wrapped = withRetry(flaky, {
      maxAttempts: 5,
      baseDelayMs: 60_000,
      isFailure: () => true,
    });

    const runPromise = runPipelineToSummary([wrapped], ctx, { signal: controller.signal });

    // Wait for attempt 1 to complete and withRetry to enter its backoff.
    await drainMicrotasks();
    expect(attempts).toBe(1);

    controller.abort('user');
    await expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toBe(1);
  }, 5_000);
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

        // Simulate an async cleanup phase via a microtask chain — the
        // adapter completes its cleanup BEFORE resolving `result`. Honors
        // the AgentRun contract that run.result settles only after all
        // in-process cleanup is finished, which boundedFanoutOf awaits for
        // leak-free shutdown. The `cleanedUp` guard reflects the
        // idempotence any real adapter must provide (natural completion
        // and abort can both call cleanup).
        let cleanedUp = false;
        const cleanup = (reason: AgentRunResult['finishReason']): void => {
          if (cleanedUp) return;
          cleanedUp = true;
          Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => {
              openHandles--;
              if (resolved) postSettleMutations++;
              resolveResult({
                text: '',
                finishReason: reason,
                usage: emptyUsage,
                executedToolCalls: [],
              });
            });
        };

        // Only the failing item has a natural-completion path. Non-failing
        // peers will NEVER complete on their own — they must be aborted by
        // boundedFanoutOf's fail-fast for cleanup to fire. This is what
        // forces the test to exercise the abort-and-await-cleanup contract
        // rather than letting peers finish in the same microtask burst.
        if (config.shouldFail) {
          Promise.resolve().then(() => cleanup('error'));
        }
        composite.addEventListener('abort', () => cleanup('aborted'));

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

    // Contract: by the time boundedFanoutOf resolves, every aborted
    // adapter has finished its cleanup (because run.result resolves only
    // after the adapter is done) and there are zero post-settle mutations.
    expect(openHandles).toBe(0);
    await drainMicrotasks(20);
    expect(postSettleMutations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. TimerTrigger payload factory hangs past trigger.stop()
// ---------------------------------------------------------------------------
describe('cancellation: TimerTrigger.stop() races an in-flight payload', () => {
  it('handle.done unblocks even when the payload promise never resolves', async () => {
    // Payload is parked on a deferred that we never resolve. If
    // TimerTrigger.stop() correctly races the payload against its
    // internal abort signal, handle.done resolves anyway. If it didn't,
    // the test would hang at its 5s timeout — a clean deterministic
    // failure signal instead of a wall-clock latency assertion.
    const payloadStarted = defer<void>();
    const neverResolves = defer<{ x: number }>();

    const trigger = new TimerTrigger<{ x: number }>({
      intervalMs: 5,
      fireImmediately: true,
      payload: async () => {
        payloadStarted.resolve();
        return neverResolves.promise;
      },
    });

    const handle = runTrigger(
      trigger,
      () => ({
        phases: [
          {
            name: 'noop',
            async *run() {
              /* no events expected — the payload never resolves */
            },
          } as Phase<Ctx>,
        ],
        ctx: { cache: new PipelineCache() } as Ctx,
      }),
    );

    await payloadStarted.promise;
    await handle.stop();
    await handle.done;
    // Reaching here means handle.done unblocked — the assertion is the
    // absence of a hang. neverResolves never resolves; if the trigger
    // had awaited the payload, handle.done would never settle.
    expect(true).toBe(true);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// 8. Race: ctx.stop set + AbortSignal fires same tick — cancellation wins
// ---------------------------------------------------------------------------
describe('cancellation: ctx.stop precedence vs AbortSignal (race nondeterminism)', () => {
  it('phase that sets ctx.stop AND a same-tick abort reports cancellation', async () => {
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

    await expect(
      runPipelineToSummary([phase], ctx, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError', message: expect.stringContaining('user-cancel') });
  });
});
