import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PipelineCache } from '../src/cache.js';
import type { BasePipelineContext, Phase } from '../src/phase.js';
import { JobRunner, type JobRunOptions } from '../src/session/job-runner.js';
import type { JobStore } from '../src/session/job-store.js';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import { V5CustomJobStore } from '../test-d/job-store-v5.js';

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

  it('drains exactly once before restoring hooks when ownership acquisition returns false', async () => {
    const jobId = await runner.create('owned-elsewhere', null);
    await store.setRunning(jobId, { ownerId: 'winner' });
    const previousController = new AbortController();
    const previousHeartbeat = vi.fn(async () => undefined);
    const ctx: Ctx = {
      cache: new PipelineCache(),
      signal: previousController.signal,
      heartbeat: previousHeartbeat,
    };
    const drainStarted = deferred<void>();
    const releaseDrain = deferred<void>();
    const order: string[] = [];

    const running = runner.run(jobId, [successfulPhase], ctx, undefined, {
      ownership: { ownerId: 'loser' },
      drains: [
        async () => {
          order.push('first-start');
          expect(ctx.signal).not.toBe(previousController.signal);
          expect(ctx.heartbeat).toBe(previousHeartbeat);
          expect(runner.signalFor(jobId)).toBeDefined();
          drainStarted.resolve();
          await releaseDrain.promise;
          order.push('first-end');
        },
        () => { order.push('second'); },
      ],
    });

    await drainStarted.promise;
    expect(order).toEqual(['first-start']);
    expect(ctx.signal).not.toBe(previousController.signal);
    releaseDrain.resolve();

    await expect(running).rejects.toThrow(`Job ${jobId} is already owned or terminal`);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    expect(ctx.signal).toBe(previousController.signal);
    expect(ctx.heartbeat).toBe(previousHeartbeat);
    expect(runner.signalFor(jobId)).toBeUndefined();
  });

  it('attempts every drain after acquisition rejection and keeps that error primary', async () => {
    const acquisitionError = new Error('ownership backend unavailable');
    const rejectingStore = new Proxy(store, {
      get(target, property) {
        if (property === 'setRunning') return async () => { throw acquisitionError; };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JobStore;
    const rejectingRunner = new JobRunner(rejectingStore);
    const firstDrainError = new Error('first drain failed');
    const secondDrain = vi.fn(async () => { throw new Error('second drain failed'); });
    const ctx: Ctx = { cache: new PipelineCache() };

    const error = await rejectingRunner.run('claim-rejected', [successfulPhase], ctx, undefined, {
      drains: [
        async () => { throw firstDrainError; },
        secondDrain,
      ],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ message: acquisitionError.message });
    expect((error as AggregateError).errors).toEqual([
      acquisitionError,
      firstDrainError,
      expect.objectContaining({ message: 'second drain failed' }),
    ]);
    expect(secondDrain).toHaveBeenCalledOnce();
    expect(ctx.signal).toBeUndefined();
    expect(rejectingRunner.signalFor('claim-rejected')).toBeUndefined();
  });

  it('does not let a context restoration setter hide the pipeline failure', async () => {
    const pipelineError = new Error('pipeline remained primary');
    const restorationError = new Error('signal restoration failed');
    const previousController = new AbortController();
    let currentSignal: AbortSignal | undefined = previousController.signal;
    const ctx: Ctx = { cache: new PipelineCache() };
    Object.defineProperty(ctx, 'signal', {
      configurable: true,
      get: () => currentSignal,
      set(value: AbortSignal | undefined) {
        if (value === previousController.signal) throw restorationError;
        currentSignal = value;
      },
    });
    const failingPhase: Phase<Ctx> = {
      name: 'fail',
      async *run() {
        throw pipelineError;
      },
    };
    const jobId = await runner.create('restore-setter-failure', null);

    expect(await runner.run(jobId, [failingPhase], ctx).catch((error: unknown) => error)).toBe(pipelineError);
    expect((await store.getJob(jobId))?.status).toBe('FAILED');
    expect(currentSignal).not.toBe(previousController.signal);
  });

  it('preserves a pre-registration setup error and allows context reuse through run()', async () => {
    const setupError = new Error('drain getter failed');
    const drains: JobRunOptions['drains'] = [];
    Object.defineProperty(drains, 0, {
      configurable: true,
      enumerable: true,
      get() { throw setupError; },
    });
    Object.defineProperty(drains, 'length', { value: 1 });
    const previousController = new AbortController();
    const previousHeartbeat = vi.fn(async () => undefined);
    const ctx: Ctx = {
      cache: new PipelineCache(),
      signal: previousController.signal,
      heartbeat: previousHeartbeat,
    };
    const failedJobId = await runner.create('setup-getter-run', null);

    const error = await runner.run(
      failedJobId,
      [successfulPhase],
      ctx,
      undefined,
      { drains },
    ).catch((caught: unknown) => caught);

    expect(error).toBe(setupError);
    expect(ctx.signal).toBe(previousController.signal);
    expect(ctx.heartbeat).toBe(previousHeartbeat);
    expect(runner.signalFor(failedJobId)).toBeUndefined();

    const retryJobId = await runner.create('after-setup-getter-run', null);
    await expect(runner.run(retryJobId, [successfulPhase], ctx)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('returns the original pre-registration setup rejection from start() without an orphan', async () => {
    const setupError = new Error('start drain getter failed');
    const drains: JobRunOptions['drains'] = [];
    Object.defineProperty(drains, 0, {
      configurable: true,
      enumerable: true,
      get() { throw setupError; },
    });
    Object.defineProperty(drains, 'length', { value: 1 });
    const previousController = new AbortController();
    const previousHeartbeat = vi.fn(async () => undefined);
    const ctx: Ctx = {
      cache: new PipelineCache(),
      signal: previousController.signal,
      heartbeat: previousHeartbeat,
    };
    const failedJobId = await runner.create('setup-getter-start', null);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const handle = runner.start(
        failedJobId,
        [successfulPhase],
        ctx,
        undefined,
        { drains },
      );
      expect(handle.signal.aborted).toBe(true);
      expect(await handle.result.catch((caught: unknown) => caught)).toBe(setupError);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(ctx.signal).toBe(previousController.signal);
      expect(ctx.heartbeat).toBe(previousHeartbeat);
      expect(runner.signalFor(failedJobId)).toBeUndefined();

      const retryJobId = await runner.create('after-setup-getter-start', null);
      await expect(runner.run(retryJobId, [successfulPhase], ctx)).resolves.toMatchObject({
        status: 'completed',
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it.each([
    { mode: 'run', contextKind: 'frozen' },
    { mode: 'start', contextKind: 'frozen' },
    { mode: 'run', contextKind: 'throwing signal setter' },
    { mode: 'start', contextKind: 'throwing signal setter' },
  ] as const)('does not claim after $contextKind setup fails through $mode()', async ({ mode, contextKind }) => {
    const setupError = new Error(`${contextKind} rejected signal installation`);
    const ctx: Ctx = { cache: new PipelineCache() };
    if (contextKind === 'frozen') {
      Object.freeze(ctx);
    } else {
      Object.defineProperty(ctx, 'signal', {
        configurable: true,
        get: () => undefined,
        set: () => { throw setupError; },
      });
    }
    const jobId = await runner.create(`setup-${mode}-${contextKind}`, null);
    const setRunning = vi.spyOn(store, 'setRunning');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      let result: Promise<unknown>;
      if (mode === 'start') {
        const handle = runner.start(jobId, [successfulPhase], ctx);
        expect(handle.signal.aborted).toBe(true);
        result = handle.result;
      } else {
        result = runner.run(jobId, [successfulPhase], ctx);
      }
      const error = await result.catch((caught: unknown) => caught);
      await new Promise<void>((resolve) => setImmediate(resolve));

      if (contextKind === 'frozen') expect(error).toBeInstanceOf(TypeError);
      else expect(error).toBe(setupError);
      expect(setRunning).not.toHaveBeenCalled();
      expect((await store.getJob(jobId))?.status).toBe('PENDING');
      expect(runner.signalFor(jobId)).toBeUndefined();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it.each([
    {
      kind: 'bundled SQLite',
      makeStore: (): JobStore => store,
    },
    {
      kind: 'v5 structural custom-store',
      makeStore: (): JobStore => new V5CustomJobStore(),
    },
  ])('defers synchronous $kind acquisition throws until start returns and cleans up', async ({ kind, makeStore }) => {
    const acquisitionError = new Error(`${kind} acquisition threw synchronously`);
    const target = makeStore();
    const acquisitionMethod = 'setRunning';
    const acquisition = vi.fn((..._args: Parameters<JobStore['setRunning']>): Promise<boolean> => {
      acquisition.mockImplementation((...args: Parameters<JobStore['setRunning']>) => target.setRunning(...args));
      throw acquisitionError;
    });
    const throwingStore = new Proxy(target, {
      get(storeTarget, property) {
        if (property === acquisitionMethod) return acquisition;
        const value = Reflect.get(storeTarget, property, storeTarget) as unknown;
        return typeof value === 'function' ? value.bind(storeTarget) : value;
      },
    }) as JobStore;
    const throwingRunner = new JobRunner(throwingStore);
    const previousController = new AbortController();
    const previousHeartbeat = vi.fn(async () => undefined);
    const ctx: Ctx = {
      cache: new PipelineCache(),
      signal: previousController.signal,
      heartbeat: previousHeartbeat,
    };
    const firstDrain = vi.fn(() => {
      expect(ctx.signal).not.toBe(previousController.signal);
      expect(ctx.heartbeat).toBe(previousHeartbeat);
      expect(throwingRunner.signalFor('sync-claim-throw')).toBeDefined();
    });
    const secondDrain = vi.fn();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const handle = throwingRunner.start('sync-claim-throw', [successfulPhase], ctx, undefined, {
        drains: [firstDrain, secondDrain],
      });

      // Acquisition itself is deferred, so start can expose a fully initialized
      // handle before a non-async structural store has a chance to throw.
      expect(acquisition).not.toHaveBeenCalled();
      expect(handle.signal).toBe(ctx.signal);
      const error = await handle.result.catch((caught: unknown) => caught);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(acquisition).toHaveBeenCalledOnce();
      expect(error).toBe(acquisitionError);
      expect(firstDrain).toHaveBeenCalledOnce();
      expect(secondDrain).toHaveBeenCalledOnce();
      expect(unhandled).toEqual([]);
      expect(ctx.signal).toBe(previousController.signal);
      expect(ctx.heartbeat).toBe(previousHeartbeat);
      expect(throwingRunner.signalFor('sync-claim-throw')).toBeUndefined();

      // Reuse both the runner and context that saw the synchronous throw. A
      // leaked inflight or active-context registration would reject this retry.
      const retryJobId = await target.createJob(`after-${kind}-sync-throw`, null);
      await expect(throwingRunner.run(retryJobId, [successfulPhase], ctx)).resolves.toMatchObject({
        status: 'completed',
      });
      expect(acquisition).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
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

  it('preserves pipeline, drain, and failed-terminal persistence errors in order', async () => {
    const pipelineFailure = new Error('pipeline failed');
    const drainFailure = new Error('drain failed');
    const persistenceFailure = new Error('FAILED finalization rejected');
    const finalizeJob = store.finalizeJob.bind(store);
    store.finalizeJob = async (jobId, finalization) => {
      if (finalization.status === 'FAILED') throw persistenceFailure;
      return finalizeJob(jobId, finalization);
    };
    const phase: Phase<Ctx> = {
      name: 'fail',
      async *run() {
        throw pipelineFailure;
      },
    };
    const jobId = await runner.create('pipeline-drain-persistence-failure', null);
    const running = runner.run(
      jobId,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { drains: [async () => { throw drainFailure; }] },
    );

    const error = await running.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      pipelineFailure,
      drainFailure,
      persistenceFailure,
    ]);
    expect(await store.getJob(jobId)).toMatchObject({ status: 'RUNNING' });
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

  it('orders cancellation, request persistence, and drain failures deterministically', async () => {
    const requestFailure = new Error('request append failed');
    const drainFailure = new Error('drain failed');
    const appendEvent = store.appendEvent.bind(store);
    store.appendEvent = async (jobId, event) => {
      if (event.type === 'cancellation_requested') throw requestFailure;
      return appendEvent(jobId, event);
    };
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
    const jobId = await runner.create('cancel-persistence-and-drain-failure', null);
    const running = runner.run(
      jobId,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { drains: [async () => { throw drainFailure; }] },
    );

    await phaseStarted.promise;
    runner.cancel(jobId, 'operator stop');
    const error = await running.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ name: 'AbortError', message: 'cancelled: operator stop' });
    const failures = (error as AggregateError).errors;
    expect(failures[0]).toMatchObject({ name: 'AbortError' });
    expect(failures[1]).toBe(requestFailure);
    expect(failures[2]).toBe(drainFailure);
    expect(await store.getJob(jobId)).toMatchObject({ status: 'CANCELLED' });
    expect((await store.getEvents(jobId)).map((event) => event.eventType)).toEqual(['cancelled']);
  });
});
