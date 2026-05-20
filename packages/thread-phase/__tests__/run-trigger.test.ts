/**
 * runTrigger — consumes a Trigger and dispatches pipelines.
 */

import { describe, it, expect, vi } from 'vitest';
import { runTrigger } from '../src/triggers/run-trigger.js';
import { TimerTrigger } from '../src/triggers/timer-trigger.js';
import type { Trigger, TriggerEvent } from '../src/triggers/types.js';
import { PipelineCache } from '../src/cache.js';
import { JobRunner } from '../src/session/job-runner.js';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import type {
  BasePipelineContext,
  Phase,
} from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  input?: unknown;
  ran?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Manual trigger: yields whatever you push, until stop. */
class ManualTrigger<T> implements Trigger<T> {
  readonly name = 'manual';
  private seq = 0;
  private queue: TriggerEvent<T>[] = [];
  private resolveWait: (() => void) | null = null;
  private stopped = false;

  push(input: T): void {
    this.queue.push({
      id: ++this.seq,
      occurredAt: new Date().toISOString(),
      input,
    });
    this.resolveWait?.();
    this.resolveWait = null;
  }

  async *start(): AsyncGenerator<TriggerEvent<T>, void> {
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

const makeCtx = (input: unknown): Ctx => ({
  cache: new PipelineCache(),
  input,
  ran: false,
});

const tagPhase = (capture: string[]): Phase<Ctx> => ({
  name: 'tag',
  async *run(ctx) {
    ctx.ran = true;
    capture.push(String(ctx.input));
    yield { type: 'phase', phase: 'tag' };
  },
});

describe('runTrigger', () => {
  it('runs a pipeline per trigger event (inline mode)', async () => {
    const trigger = new ManualTrigger<string>();
    const captured: string[] = [];

    const handle = runTrigger(
      trigger,
      (input) => ({
        phases: [tagPhase(captured)],
        ctx: makeCtx(input),
      }),
      { maxConcurrency: 1 },
    );

    trigger.push('a');
    trigger.push('b');
    trigger.push('c');

    // Let dispatches drain.
    await sleep(40);
    await handle.stop();
    await handle.done;

    expect(captured).toEqual(['a', 'b', 'c']);
  });

  it('persists each pipeline through a JobRunner when provided', async () => {
    const store = new SqliteJobStore(':memory:');
    const runner = new JobRunner(store);
    const trigger = new ManualTrigger<string>();
    const captured: string[] = [];

    const handle = runTrigger(
      trigger,
      (input) => ({
        phases: [tagPhase(captured)],
        ctx: makeCtx(input),
      }),
      {
        jobRunner: runner,
        jobStore: store,
        pipelineName: 'test-pipeline',
        maxConcurrency: 1,
      },
    );

    trigger.push('first');
    trigger.push('second');

    await sleep(50);
    await handle.stop();
    await handle.done;

    expect(captured).toEqual(['first', 'second']);

    const jobs = store.listJobs({ limit: 10 });
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.name === 'test-pipeline')).toBe(true);
    expect(jobs.every((j) => j.status === 'COMPLETED')).toBe(true);
    const triggerEventIds = jobs
      .map((j) => (j.input as { triggerEventId: number }).triggerEventId)
      .sort();
    expect(triggerEventIds).toEqual([1, 2]);

    store.close();
  });

  it('invokes onStart and onComplete around successful pipelines', async () => {
    const onStart = vi.fn();
    const onComplete = vi.fn();
    const trigger = new ManualTrigger<string>();

    const handle = runTrigger(
      trigger,
      (input) => ({ phases: [tagPhase([])], ctx: makeCtx(input) }),
      { onStart, onComplete },
    );

    trigger.push('one');
    await sleep(30);
    await handle.stop();
    await handle.done;

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onStart.mock.calls[0]?.[0]?.id).toBe(1);
  });

  it('calls onError when a pipeline throws, without stopping the loop', async () => {
    const onError = vi.fn();
    const trigger = new ManualTrigger<{ ok: boolean }>();
    const captured: string[] = [];

    const flakyPhase: Phase<Ctx> = {
      name: 'flaky',
      async *run(ctx) {
        const input = ctx.input as { ok: boolean };
        if (!input.ok) throw new Error('boom');
        captured.push('ok');
        yield { type: 'phase', phase: 'flaky' };
      },
    };

    const handle = runTrigger(
      trigger,
      (input) => ({ phases: [flakyPhase], ctx: makeCtx(input) }),
      { onError, maxConcurrency: 1 },
    );

    trigger.push({ ok: false });
    trigger.push({ ok: true });
    trigger.push({ ok: false });
    trigger.push({ ok: true });

    await sleep(60);
    await handle.stop();
    await handle.done;

    expect(onError).toHaveBeenCalledTimes(2);
    expect(captured).toEqual(['ok', 'ok']);
  });

  it('maxConcurrency caps in-flight pipelines, backpressuring the trigger', async () => {
    const trigger = new ManualTrigger<number>();
    const captured: string[] = [];
    const concurrencyObserved: number[] = [];
    let inFlight = 0;

    const slowPhase: Phase<Ctx> = {
      name: 'slow',
      async *run(ctx) {
        inFlight++;
        concurrencyObserved.push(inFlight);
        await sleep(40);
        captured.push(String(ctx.input));
        inFlight--;
        yield { type: 'phase', phase: 'slow' };
      },
    };

    const handle = runTrigger(
      trigger,
      (input) => ({ phases: [slowPhase], ctx: makeCtx(input) }),
      { maxConcurrency: 2 },
    );

    for (let i = 1; i <= 4; i++) trigger.push(i);

    await sleep(200);
    await handle.stop();
    await handle.done;

    // All 4 events processed (none dropped) — backpressure only paces them.
    expect(captured.sort()).toEqual(['1', '2', '3', '4']);
    // Concurrency never exceeded the cap.
    expect(Math.max(...concurrencyObserved)).toBeLessThanOrEqual(2);
  });

  it('AbortSignal stops the loop and resolves done', async () => {
    const trigger = new TimerTrigger({ intervalMs: 20 });
    const controller = new AbortController();
    let dispatches = 0;

    const handle = runTrigger(
      trigger,
      () => ({
        phases: [
          {
            name: 'count',
            async *run() {
              dispatches++;
              yield { type: 'phase', phase: 'count' };
            },
          },
        ],
        ctx: { cache: new PipelineCache() },
      }),
      { signal: controller.signal },
    );

    await sleep(50);
    controller.abort();
    await handle.done;

    // Should have run 1-3 times before the abort.
    expect(dispatches).toBeGreaterThanOrEqual(1);
    expect(dispatches).toBeLessThanOrEqual(4);
  });

  it('preimmediately-aborted signal stops before any dispatch', async () => {
    const trigger = new TimerTrigger({ intervalMs: 10, fireImmediately: true });
    const controller = new AbortController();
    controller.abort();
    let dispatches = 0;

    const handle = runTrigger(
      trigger,
      () => ({
        phases: [
          {
            name: 'count',
            async *run() {
              dispatches++;
              yield { type: 'phase', phase: 'count' };
            },
          },
        ],
        ctx: { cache: new PipelineCache() },
      }),
      { signal: controller.signal },
    );

    await handle.done;
    expect(dispatches).toBe(0);
  });

  it('handle.stop() resolves done after outstanding pipelines complete', async () => {
    const trigger = new ManualTrigger<number>();
    const captured: string[] = [];

    const slowPhase: Phase<Ctx> = {
      name: 'slow',
      async *run(ctx) {
        await sleep(30);
        captured.push(String(ctx.input));
        yield { type: 'phase', phase: 'slow' };
      },
    };

    const handle = runTrigger(
      trigger,
      (input) => ({ phases: [slowPhase], ctx: makeCtx(input) }),
      { maxConcurrency: 3 },
    );

    trigger.push(1);
    trigger.push(2);
    await sleep(5);
    await handle.stop();
    await handle.done;

    // Both in-flight pipelines completed before done resolved.
    expect(captured.sort()).toEqual(['1', '2']);
  });
});
