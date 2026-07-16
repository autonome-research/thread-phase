import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineCache } from '../src/cache.js';
import type { BasePipelineContext, Phase } from '../src/phase.js';
import { JobRunner } from '../src/session/job-runner.js';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Ctx extends BasePipelineContext {}

let dir: string;
let store: SqliteJobStore;
let runner: JobRunner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thread-phase-drain-'));
  store = new SqliteJobStore(join(dir, 'jobs.db'));
  runner = new JobRunner(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const successfulPhase: Phase<Ctx> = {
  name: 'work',
  async *run() {
    yield { type: 'phase', phase: 'work' };
  },
};

describe('JobRunner lifecycle drains', () => {
  it('awaits registered drains in order before terminal persistence', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];
    const jobId = await runner.create('ordered-drains', null);

    const running = runner.run(
      jobId,
      [successfulPhase],
      { cache: new PipelineCache() },
      undefined,
      {
        drains: [
          async () => {
            order.push('first-start');
            firstStarted.resolve();
            await releaseFirst.promise;
            order.push('first-end');
          },
          () => { order.push('second'); },
        ],
      },
    );

    await firstStarted.promise;
    expect((await store.getJob(jobId))?.status).toBe('RUNNING');
    expect((await store.getEvents(jobId)).map((event) => event.eventType)).toEqual(['phase']);
    expect(order).toEqual(['first-start']);

    releaseFirst.resolve();
    await expect(running).resolves.toEqual({ status: 'completed', eventCount: 2 });
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect((await store.getEvents(jobId)).map((event) => event.eventType)).toEqual(['phase', 'done']);
  });

  it('attempts every drain and turns otherwise successful work into an observed failure', async () => {
    const laterDrain = vi.fn();
    const jobId = await runner.create('failed-drain', null);

    const running = runner.run(
      jobId,
      [successfulPhase],
      { cache: new PipelineCache() },
      undefined,
      {
        drains: [
          async () => { throw new Error('persistence flush failed'); },
          laterDrain,
        ],
      },
    );

    await expect(running).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'One or more lifecycle drains failed',
    });
    expect(laterDrain).toHaveBeenCalledOnce();
    expect((await store.getJob(jobId))?.status).toBe('FAILED');
    expect((await store.getEvents(jobId)).map((event) => event.eventType)).toEqual(['phase', 'error']);
  });

  it('preserves a pipeline failure as terminal while exposing drain failures', async () => {
    const failingPhase: Phase<Ctx> = {
      name: 'fail',
      async *run() {
        throw new Error('pipeline failed');
      },
    };
    const jobId = await runner.create('pipeline-and-drain-failure', null);

    const running = runner.run(
      jobId,
      [failingPhase],
      { cache: new PipelineCache() },
      undefined,
      { drains: [async () => { throw new Error('drain also failed'); }] },
    );

    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ message: 'pipeline failed' });
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as AggregateError).errors[1]).toMatchObject({ message: 'drain also failed' });
    expect(await store.getJob(jobId)).toMatchObject({ status: 'FAILED', error: 'pipeline failed' });
  });

  it('gives cancellation precedence without hiding a drain failure', async () => {
    const phaseStarted = deferred<void>();
    const phase: Phase<Ctx> = {
      name: 'wait-for-cancel',
      async *run(ctx) {
        phaseStarted.resolve();
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    const jobId = await runner.create('cancel-and-drain-failure', null);
    const running = runner.run(
      jobId,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { drains: [async () => { throw new Error('close failed'); }] },
    );

    await phaseStarted.promise;
    runner.cancel(jobId, 'operator stop');
    const error = await running.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ name: 'AbortError', message: 'cancelled: operator stop' });
    expect((error as AggregateError).errors.at(-1)).toMatchObject({ message: 'close failed' });
    expect(await store.getJob(jobId)).toMatchObject({ status: 'CANCELLED', error: 'operator stop' });
    expect((await store.getEvents(jobId)).map((event) => event.eventType)).toEqual([
      'cancellation_requested',
      'cancelled',
    ]);
  });
});
