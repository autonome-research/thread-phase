/**
 * Tests for v4.1.0 durability triplet: ownership metadata, heartbeat,
 * and read-time staleness. Covers SqliteJobStore + JobRunner together
 * since the three features are tightly coupled (heartbeat writes the
 * heartbeatAt column; staleness reads it; ownership is recorded by the
 * same code path).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import {
  JobOwnershipLostError,
  type EventRecord,
  type JobRecord,
  type JobStore,
} from '../src/session/job-store.js';
import { JobOwnershipLostError as SessionOwnershipLostError } from '../src/session/index.js';
import { JobOwnershipLostError as RootOwnershipLostError } from '../src/index.js';
import { JobRunner } from '../src/session/job-runner.js';
import { PipelineCache } from '../src/cache.js';
import type { Phase, BasePipelineContext } from '../src/phase.js';

let dbDir: string;
let store: SqliteJobStore;

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), 'tp-test-'));
  store = new SqliteJobStore(join(dbDir, 'jobs.db'));
});

afterEach(() => {
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

describe('ownership metadata', () => {
  it('setRunning records sessionId + pid + ppid + cwd + hostname when supplied', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id, {
      sessionId: 'session-abc',
      pid: 12345,
      ppid: 12000,
      cwd: '/var/run/tp',
      hostname: 'worker-1',
    });
    const job = await store.getJob(id);
    expect(job?.sessionId).toBe('session-abc');
    expect(job?.pid).toBe(12345);
    expect(job?.ppid).toBe(12000);
    expect(job?.cwd).toBe('/var/run/tp');
    expect(job?.hostname).toBe('worker-1');
  });

  it('ownership fields are optional and undefined when not supplied', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id);
    const job = await store.getJob(id);
    expect(job?.sessionId).toBeUndefined();
    expect(job?.pid).toBeUndefined();
    expect(job?.ppid).toBeUndefined();
  });

  it('JobRunner auto-populates pid/ppid/cwd/hostname from the runtime', async () => {
    const runner = new JobRunner(store);
    const id = await runner.create('p1', null);
    const phase: Phase<BasePipelineContext> = {
      name: 'noop',
      async *run() {},
    };
    await runner.run(id, [phase], { cache: new PipelineCache() });
    const job = await store.getJob(id);
    expect(job?.pid).toBe(process.pid);
    expect(typeof job?.hostname).toBe('string');
    expect(typeof job?.cwd).toBe('string');
    expect(job?.ownerId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('JobRunner records caller launch source and owner identity', async () => {
    const runner = new JobRunner(store);
    const id = await runner.create('p1', null);
    const phase: Phase<BasePipelineContext> = { name: 'noop', async *run() {} };
    await runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { launchSource: 'pi-tool', ownership: { ownerId: 'owner-abc' } },
    );
    expect(await store.getJob(id)).toMatchObject({
      launchSource: 'pi-tool',
      ownerId: 'owner-abc',
    });
  });

  it('atomically refuses a second JobRunner owner for the same job id', async () => {
    const firstRunner = new JobRunner(store);
    const secondRunner = new JobRunner(store);
    const id = await firstRunner.create('claimed', null);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    const phase: Phase<BasePipelineContext> = {
      name: 'wait',
      async *run() {
        executions++;
        await gate;
      },
    };
    const first = firstRunner.run(id, [phase], { cache: new PipelineCache() });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      secondRunner.run(id, [phase], { cache: new PipelineCache() }),
    ).rejects.toThrow(/already owned/);
    expect(executions).toBe(1);
    release();
    await first;
  });

  it('allows concurrent ordinary JobRunner runs with the same pipeline name', async () => {
    const runner = new JobRunner(store);
    const firstId = await runner.create('shared-pipeline', null);
    const secondId = await runner.create('shared-pipeline', null);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let startedCount = 0;
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const phase: Phase<BasePipelineContext> = {
      name: 'overlap',
      async *run() {
        startedCount++;
        if (startedCount === 2) bothStarted();
        await gate;
      },
    };

    const first = runner.run(firstId, [phase], { cache: new PipelineCache() });
    const second = runner.run(secondId, [phase], { cache: new PipelineCache() });
    await started;
    expect((await store.getJob(firstId))?.status).toBe('RUNNING');
    expect((await store.getJob(secondId))?.status).toBe('RUNNING');
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('JobRunner accepts a caller-supplied sessionId via run options', async () => {
    const runner = new JobRunner(store);
    const id = await runner.create('p1', null);
    const phase: Phase<BasePipelineContext> = {
      name: 'noop',
      async *run() {},
    };
    await runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { sessionId: 'request-xyz' },
    );
    const job = await store.getJob(id);
    expect(job?.sessionId).toBe('request-xyz');
  });

  it('subsequent setRunning calls do not null out previously-recorded ownership', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id, { sessionId: 's1', pid: 1 });
    await store.setRunning(id); // no ownership this time
    const job = await store.getJob(id);
    expect(job?.sessionId).toBe('s1');
    expect(job?.pid).toBe(1);
  });
});

describe('heartbeat', () => {
  it('validates heartbeat timeout configuration', () => {
    expect(() => new JobRunner(store, { heartbeatMs: 10, heartbeatTimeoutMs: 0 })).toThrow(
      /heartbeatTimeoutMs must be a positive safe integer/,
    );
    expect(() => new JobRunner(store, { heartbeatTimeoutMs: 10 })).toThrow(
      /heartbeatTimeoutMs requires heartbeatMs/,
    );
  });

  it('exports the stable ownership-loss error from root and session entry points', () => {
    expect(SessionOwnershipLostError).toBe(JobOwnershipLostError);
    expect(RootOwnershipLostError).toBe(JobOwnershipLostError);
  });

  it('store.heartbeat updates heartbeatAt for a RUNNING job', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id);
    const before = (await store.getJob(id))?.heartbeatAt;
    await new Promise((r) => setTimeout(r, 1100)); // sqlite datetime() is second-precision
    await store.heartbeat(id);
    const after = (await store.getJob(id))?.heartbeatAt;
    expect(after).toBeDefined();
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it('store.heartbeat is a no-op for non-RUNNING jobs', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id);
    await store.setCompleted(id, { ok: true });
    const before = (await store.getJob(id))?.heartbeatAt;
    await new Promise((r) => setTimeout(r, 50));
    await store.heartbeat(id);
    const after = (await store.getJob(id))?.heartbeatAt;
    expect(after?.getTime()).toBe(before?.getTime());
  });

  it('owner-scoped heartbeat refreshes only the current owner', async () => {
    const id = await store.createJob('owned', null);
    await store.setRunning(id, { ownerId: 'owner-a', heartbeatEnabled: true });

    await expect(store.heartbeat(id, 'owner-a')).resolves.toBeUndefined();
    await expect(store.heartbeat(id, 'owner-b')).rejects.toMatchObject({
      name: 'JobOwnershipLostError',
      code: 'ERR_JOB_OWNERSHIP_LOST',
      jobId: id,
      ownerId: 'owner-b',
    });
  });

  it('owner-scoped heartbeat reports ownership loss for terminal and missing jobs', async () => {
    const id = await store.createJob('terminal', null);
    await store.setRunning(id, { ownerId: 'owner-a' });
    await store.setCompleted(id, null, 'owner-a');

    await expect(store.heartbeat(id, 'owner-a')).rejects.toBeInstanceOf(JobOwnershipLostError);
    await expect(store.heartbeat('missing-job', 'owner-a')).rejects.toBeInstanceOf(
      JobOwnershipLostError,
    );
  });

  it('JobRunner automatic heartbeats carry the acquired owner id', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 50 });
    const id = await runner.create('p1', null);
    const heartbeatSpy = vi.spyOn(store, 'refreshHeartbeat');
    const phase: Phase<BasePipelineContext> = {
      name: 'slow',
      async *run() {
        await new Promise((r) => setTimeout(r, 200));
      },
    };
    await runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { ownership: { ownerId: 'owner-auto' } },
    );
    expect(heartbeatSpy.mock.calls.length).toBeGreaterThan(1);
    expect(heartbeatSpy.mock.calls.every((call) => call[1] === 'owner-auto')).toBe(true);
  });

  it('honors an explicit per-run automatic-heartbeat opt-out', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10 });
    const id = await runner.create('heartbeat-opt-out', null);
    const refreshSpy = vi.spyOn(store, 'refreshHeartbeat');
    const phase: Phase<BasePipelineContext> = {
      name: 'slow-without-heartbeat',
      async *run() { await new Promise((resolve) => setTimeout(resolve, 50)); },
    };

    await runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { ownership: { heartbeatEnabled: false } },
    );
    expect(refreshSpy).not.toHaveBeenCalled();
    expect((await store.getJob(id))?.heartbeatEnabled).toBe(false);
  });

  it('allows manual opt-in after suppressing automatic refresh', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10 });
    const id = await runner.create('manual-after-opt-out', null);
    const refreshSpy = vi.spyOn(store, 'enableHeartbeat');
    const phase: Phase<BasePipelineContext> = {
      name: 'manual-opt-in',
      async *run(ctx) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(refreshSpy).not.toHaveBeenCalled();
        await ctx.heartbeat?.();
      },
    };

    await runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { ownership: { heartbeatEnabled: false } },
    );
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect((await store.getJob(id))?.heartbeatEnabled).toBe(true);
  });

  it('manual ctx.heartbeat opts a run into stale detection without heartbeatMs', async () => {
    const runner = new JobRunner(store);
    const id = await runner.create('manual-heartbeat', null);
    let heartbeated!: () => void;
    const observed = new Promise<void>((resolve) => { heartbeated = resolve; });
    const phase: Phase<BasePipelineContext> = {
      name: 'manual',
      async *run(ctx) {
        await ctx.heartbeat?.();
        heartbeated();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    };
    const running = runner.run(id, [phase], { cache: new PipelineCache() });
    await observed;
    expect((await store.getJob(id))?.heartbeatEnabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await store.getJob(id, { staleAfterMs: 1000 }))?.status).toBe('STALE');
    runner.cancel(id, 'test cleanup');
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('JobRunner clears the heartbeat timer on every exit path (success)', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10 });
    const id = await runner.create('p1', null);
    const heartbeatSpy = vi.spyOn(store, 'refreshHeartbeat');
    const phase: Phase<BasePipelineContext> = {
      name: 'slow',
      async *run() { await new Promise((resolve) => setTimeout(resolve, 50)); },
    };
    await runner.run(id, [phase], { cache: new PipelineCache() });
    const callsAtFinish = heartbeatSpy.mock.calls.length;
    expect(callsAtFinish).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(heartbeatSpy.mock.calls.length).toBe(callsAtFinish);
  });

  it('serializes slow automatic heartbeat attempts', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10, heartbeatTimeoutMs: 500 });
    const id = await runner.create('serialized-heartbeat', null);
    let releaseHeartbeat!: () => void;
    const heartbeatGate = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
    let firstHeartbeat!: () => void;
    const heartbeatStarted = new Promise<void>((resolve) => { firstHeartbeat = resolve; });
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(store, 'refreshHeartbeat').mockImplementation(async () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      firstHeartbeat();
      await heartbeatGate;
      inFlight--;
      return true;
    });
    let releasePhase!: () => void;
    const phaseGate = new Promise<void>((resolve) => { releasePhase = resolve; });
    const phase: Phase<BasePipelineContext> = {
      name: 'wait',
      async *run() { await phaseGate; },
    };

    const running = runner.run(id, [phase], { cache: new PipelineCache() });
    await heartbeatStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(1);
    expect(maxInFlight).toBe(1);
    releaseHeartbeat();
    releasePhase();
    await running;
  });

  it('stops promptly without overwriting state after actual automatic owner loss', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10 });
    const id = await runner.create('automatic-owner-loss', null);
    // A published-v5 custom store may retain heartbeat()'s legacy no-op
    // behavior; automatic owner detection must use enableHeartbeat's boolean.
    const legacyHeartbeat = vi.spyOn(store, 'heartbeat').mockResolvedValue(undefined);
    let phaseStarted!: () => void;
    const started = new Promise<void>((resolve) => { phaseStarted = resolve; });
    const phase: Phase<BasePipelineContext> = {
      name: 'wait-for-owner-loss',
      async *run(ctx) {
        phaseStarted();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true });
        });
      },
    };

    const running = runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { ownership: { ownerId: 'displaced-owner' } },
    );
    await started;
    await store.setAbandoned(id, 'ownership transferred');

    await expect(running).rejects.toMatchObject({
      name: 'JobOwnershipLostError',
      code: 'ERR_JOB_OWNERSHIP_LOST',
      jobId: id,
      ownerId: 'displaced-owner',
    });
    expect(await store.getJob(id)).toMatchObject({
      status: 'ABANDONED',
      error: 'ownership transferred',
    });
    expect((await store.getEvents(id)).filter((event) => event.eventType === 'error')).toHaveLength(0);
    expect(legacyHeartbeat).not.toHaveBeenCalled();
  });

  it('turns automatic heartbeat rejection into one stable run failure', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10 });
    const id = await runner.create('heartbeat-failure', null);
    const failure = new Error('heartbeat backend unavailable');
    const heartbeatSpy = vi.spyOn(store, 'refreshHeartbeat').mockRejectedValue(failure);
    const phase: Phase<BasePipelineContext> = {
      name: 'wait-for-abort',
      async *run(ctx) {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true });
        });
      },
    };

    await expect(runner.run(id, [phase], { cache: new PipelineCache() })).rejects.toBe(failure);
    expect(heartbeatSpy).toHaveBeenCalledTimes(1);
    expect(await store.getJob(id)).toMatchObject({
      status: 'FAILED',
      error: 'heartbeat backend unavailable',
    });
    expect((await store.getEvents(id)).filter((event) => event.eventType === 'error')).toHaveLength(1);
  });

  it('keeps heartbeat failure primary when FAILED finalization also rejects', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10 });
    const id = await runner.create('heartbeat-and-finalization-failure', null);
    const heartbeatFailure = new Error('heartbeat backend unavailable');
    const persistenceFailure = new Error('FAILED finalization unavailable');
    vi.spyOn(store, 'refreshHeartbeat').mockRejectedValue(heartbeatFailure);
    const finalizeJob = store.finalizeJob.bind(store);
    vi.spyOn(store, 'finalizeJob').mockImplementation(async (jobId, finalization) => {
      if (finalization.status === 'FAILED') throw persistenceFailure;
      return finalizeJob(jobId, finalization);
    });
    const phase: Phase<BasePipelineContext> = {
      name: 'wait-for-abort',
      async *run(ctx) {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(ctx.signal?.reason), { once: true });
        });
      },
    };

    const error = await runner.run(id, [phase], { cache: new PipelineCache() })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([heartbeatFailure, persistenceFailure]);
    expect(await store.getJob(id)).toMatchObject({ status: 'RUNNING' });
  });

  it('reports manual heartbeat owner loss with the stable error', async () => {
    const runner = new JobRunner(store);
    const id = await runner.create('manual-owner-loss', null);
    vi.spyOn(store, 'refreshHeartbeat').mockResolvedValue(false);
    const phase: Phase<BasePipelineContext> = {
      name: 'manual-heartbeat',
      async *run(ctx) { await ctx.heartbeat?.(); },
    };

    await expect(runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { ownership: { ownerId: 'manual-owner' } },
    )).rejects.toMatchObject({
      name: 'JobOwnershipLostError',
      code: 'ERR_JOB_OWNERSHIP_LOST',
      jobId: id,
      ownerId: 'manual-owner',
    });
  });

  it('bounds a heartbeat that never settles and still cleans up the run', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10, heartbeatTimeoutMs: 100 });
    const id = await runner.create('hung-heartbeat', null);
    let heartbeatStarted!: () => void;
    const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
    vi.spyOn(store, 'refreshHeartbeat').mockImplementation(async () => {
      heartbeatStarted();
      return new Promise<boolean>(() => undefined);
    });
    let releasePhase!: () => void;
    const phaseGate = new Promise<void>((resolve) => { releasePhase = resolve; });
    const phase: Phase<BasePipelineContext> = {
      name: 'complete-after-heartbeat-starts',
      async *run() { await phaseGate; },
    };

    const running = runner.run(id, [phase], { cache: new PipelineCache() });
    await started;
    releasePhase();
    await expect(Promise.race([
      running,
      new Promise((_, reject) => setTimeout(() => reject(new Error('run did not settle')), 1000)),
    ])).rejects.toThrow(/Heartbeat .* timed out after 100ms/);
    expect(await store.getJob(id)).toMatchObject({ status: 'FAILED' });
    expect(runner.signalFor(id)).toBeUndefined();
  });

  it('fails the run even when phase code catches a manual heartbeat rejection', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 1000 });
    const id = await runner.create('caught-manual-heartbeat-failure', null);
    const failure = new Error('manual heartbeat backend failed');
    const refreshSpy = vi.spyOn(store, 'refreshHeartbeat').mockRejectedValue(failure);
    const phase: Phase<BasePipelineContext> = {
      name: 'catch-refresh',
      async *run(ctx) {
        try { await ctx.heartbeat?.(); } catch { /* runner failure remains authoritative */ }
      },
    };

    await expect(runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { ownership: { heartbeatEnabled: false } },
    )).rejects.toBe(failure);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(await store.getJob(id)).toMatchObject({
      status: 'FAILED',
      error: 'manual heartbeat backend failed',
    });
  });

  it('bounds a manual heartbeat that never settles', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10, heartbeatTimeoutMs: 100 });
    const id = await runner.create('hung-manual-heartbeat', null);
    vi.spyOn(store, 'refreshHeartbeat').mockImplementation(
      async () => new Promise<boolean>(() => undefined),
    );
    const phase: Phase<BasePipelineContext> = {
      name: 'manual-heartbeat',
      async *run(ctx) { await ctx.heartbeat?.(); },
    };

    await expect(runner.run(
      id,
      [phase],
      { cache: new PipelineCache() },
      undefined,
      { ownership: { heartbeatEnabled: false } },
    )).rejects.toThrow(/Heartbeat .* timed out after 100ms/);
    expect(await store.getJob(id)).toMatchObject({ status: 'FAILED' });
    expect(runner.signalFor(id)).toBeUndefined();
  });

  it('keeps caller-signal cancellation authoritative when it precedes heartbeat rejection', async () => {
    const caller = new AbortController();
    const runner = new JobRunner(store, { heartbeatMs: 10, heartbeatTimeoutMs: 1000 });
    const id = await runner.create('caller-cancel-heartbeat-race', null);
    let rejectHeartbeat!: (error: Error) => void;
    const pendingHeartbeat = new Promise<void>((_resolve, reject) => { rejectHeartbeat = reject; });
    let heartbeatStarted!: () => void;
    const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
    vi.spyOn(store, 'refreshHeartbeat').mockImplementation(async () => {
      heartbeatStarted();
      await pendingHeartbeat;
      return true;
    });
    const phase: Phase<BasePipelineContext> = {
      name: 'wait-for-caller-abort',
      async *run(ctx) {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(new Error('caller stopped')), { once: true });
        });
      },
    };

    const running = runner.run(id, [phase], { cache: new PipelineCache(), signal: caller.signal });
    await started;
    caller.abort('caller cancelled');
    rejectHeartbeat(new Error('late heartbeat failure'));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.getJob(id)).toMatchObject({
      status: 'CANCELLED',
      error: 'caller cancelled',
    });
  });

  it('keeps runner cancellation authoritative when it precedes heartbeat rejection', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 10 });
    const id = await runner.create('cancel-heartbeat-race', null);
    let rejectHeartbeat!: (error: Error) => void;
    const pendingHeartbeat = new Promise<void>((_resolve, reject) => { rejectHeartbeat = reject; });
    let heartbeatStarted!: () => void;
    const started = new Promise<void>((resolve) => { heartbeatStarted = resolve; });
    vi.spyOn(store, 'refreshHeartbeat').mockImplementation(async () => {
      heartbeatStarted();
      await pendingHeartbeat;
      return true;
    });
    const phase: Phase<BasePipelineContext> = {
      name: 'wait-for-abort',
      async *run(ctx) {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(new Error('phase stopped')), { once: true });
        });
      },
    };

    const running = runner.run(id, [phase], { cache: new PipelineCache() });
    await started;
    expect(runner.cancel(id, 'operator cancelled')).toBe(true);
    rejectHeartbeat(new Error('late heartbeat failure'));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.getJob(id)).toMatchObject({
      status: 'CANCELLED',
      error: 'operator cancelled',
    });
  });

  it('rejects cancellation once successful terminal persistence has begun', async () => {
    const runner = new JobRunner(store);
    const id = await runner.create('completion-boundary', null);
    const originalFinalize = store.finalizeJob.bind(store);
    let completionStarted!: () => void;
    const started = new Promise<void>((resolve) => { completionStarted = resolve; });
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
    vi.spyOn(store, 'finalizeJob').mockImplementation(async (jobId, finalization) => {
      if (finalization.status === 'COMPLETED') {
        completionStarted();
        await completionGate;
      }
      return originalFinalize(jobId, finalization);
    });
    const phase: Phase<BasePipelineContext> = { name: 'noop', async *run() {} };

    const running = runner.run(id, [phase], { cache: new PipelineCache() });
    await started;
    expect(runner.cancel(id, 'too late')).toBe(false);
    releaseCompletion();
    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect((await store.getEvents(id)).some(
      (event) => event.eventType === 'cancellation_requested',
    )).toBe(false);
  });

  it('removes its caller-signal listener after completion', async () => {
    const caller = new AbortController();
    const removeSpy = vi.spyOn(caller.signal, 'removeEventListener');
    const runner = new JobRunner(store);
    const id = await runner.create('caller-listener-cleanup', null);
    const phase: Phase<BasePipelineContext> = { name: 'noop', async *run() {} };

    await runner.run(id, [phase], { cache: new PipelineCache(), signal: caller.signal });
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('provides an explicit operator-only heartbeat alias', async () => {
    const runner = new JobRunner(store);
    const id = await store.createJob('operator-heartbeat', null);
    await store.setRunning(id, { ownerId: 'other-owner' });
    const heartbeatSpy = vi.spyOn(store, 'heartbeat');

    await runner.heartbeatAsOperator(id);
    expect(heartbeatSpy).toHaveBeenCalledWith(id);
  });

  it('ctx.heartbeat is populated during runner.run for manual phase-level refresh', async () => {
    const runner = new JobRunner(store);
    const id = await runner.create('p1', null);
    let observedHeartbeat: undefined | (() => Promise<void>);
    const phase: Phase<BasePipelineContext> = {
      name: 'observer',
      async *run(ctx) {
        observedHeartbeat = ctx.heartbeat;
        await ctx.heartbeat?.();
      },
    };
    await runner.run(id, [phase], { cache: new PipelineCache() });
    expect(typeof observedHeartbeat).toBe('function');
    // The phase's manual ctx.heartbeat() call should have updated the row.
    expect((await store.getJob(id))?.heartbeatAt).toBeDefined();
  });
});

describe('read-time staleness', () => {
  it('does not classify default non-heartbeating runs as stale', async () => {
    const id = await store.createJob('no-heartbeat', null);
    await store.setRunning(id);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await store.getJob(id, { staleAfterMs: 100 }))?.status).toBe('RUNNING');
  });

  it('getJob with staleAfterMs reports STALE when RUNNING + heartbeat expired', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id, { heartbeatEnabled: true });
    // Heartbeat is set to "now" at setRunning. Wait long enough that the
    // staleness threshold is exceeded.
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = await store.getJob(id, { staleAfterMs: 10_000 });
    expect(fresh?.status).toBe('RUNNING');
    const stale = await store.getJob(id, { staleAfterMs: 1000 });
    expect(stale?.status).toBe('STALE');
  });

  it('staleness is read-time-only — persisted status remains RUNNING', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id, { heartbeatEnabled: true });
    await new Promise((r) => setTimeout(r, 1100));
    // Read once with staleAfterMs (would report STALE).
    await store.getJob(id, { staleAfterMs: 500 });
    // Read again WITHOUT staleAfterMs — persisted status is unchanged.
    const job = await store.getJob(id);
    expect(job?.status).toBe('RUNNING');
  });

  it('listJobs with staleAfterMs returns STALE rows; default reads return RUNNING', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id, { heartbeatEnabled: true });
    await new Promise((r) => setTimeout(r, 1100));
    const plain = await store.listJobs();
    expect(plain[0]?.status).toBe('RUNNING');
    const withStaleness = await store.listJobs({ staleAfterMs: 1000 });
    expect(withStaleness[0]?.status).toBe('STALE');
  });

  it('listJobs status:STALE + staleAfterMs filters to only stale rows', async () => {
    const stale = await store.createJob('p1', null);
    await store.setRunning(stale, { heartbeatEnabled: true });
    const fresh = await store.createJob('p2', null);
    await store.setRunning(fresh, { heartbeatEnabled: true });
    // Sleep ~3.0s so even with sqlite's second-precision datetime() the
    // stale row is clearly past the 1000ms threshold and the fresh row
    // (re-heartbeat'd below) clearly is not. With staleAfterMs=1000:
    //   stale.heartbeat_at = T0; threshold = T0+~2 → stale matches.
    //   fresh.heartbeat_at = T0+3; threshold = T0+~2 → fresh does not.
    await new Promise((r) => setTimeout(r, 3000));
    await store.heartbeat(fresh);

    const onlyStale = await store.listJobs({
      status: 'STALE',
      staleAfterMs: 1000,
    });
    expect(onlyStale).toHaveLength(1);
    expect(onlyStale[0]?.id).toBe(stale);
  });

  it('reconciles stale owners into durable ABANDONED state', async () => {
    const runner = new JobRunner(store);
    const id = await store.createJob('stale-owner', null);
    await store.setRunning(id, { ownerId: 'dead-owner', heartbeatEnabled: true });
    await new Promise((r) => setTimeout(r, 2100));
    await expect(runner.reconcileAbandoned(1000, 'owner disappeared')).resolves.toEqual([id]);
    expect(await store.getJob(id)).toMatchObject({
      status: 'ABANDONED',
      error: 'owner disappeared',
    });
    expect((await store.getEvents(id)).at(-1)?.eventType).toBe('abandoned');
  });

  it('reconciles more than one store page of stale jobs in one call', async () => {
    const runner = new JobRunner(store);
    const ids: string[] = [];
    for (let index = 0; index < 105; index++) {
      const id = await store.createJob(`stale-${index}`, null);
      await store.setRunning(id, { ownerId: `owner-${index}`, heartbeatEnabled: true });
      ids.push(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const reconciled = await runner.reconcileAbandoned(1000);
    expect(new Set(reconciled)).toEqual(new Set(ids));
    expect((await store.listJobs({ status: 'STALE', staleAfterMs: 1000, limit: 200 }))).toHaveLength(0);
  });

  it('uses one fixed staleness cutoff while a multi-page scan ages', async () => {
    const makeRecord = (id: string): JobRecord => ({
      id,
      name: id,
      input: null,
      status: 'STALE',
      result: null,
      error: null,
      eventCount: 0,
      createdAt: new Date(0),
      startedAt: new Date(0),
      completedAt: null,
      ownerId: `owner-${id}`,
      heartbeatEnabled: true,
      heartbeatAt: new Date(0),
    });
    const pages = [
      Array.from({ length: 100 }, (_, index) => makeRecord(`first-${index}`)),
      Array.from({ length: 5 }, (_, index) => makeRecord(`second-${index}`)),
      [],
    ];
    let fakeNow = 10_000;
    const expectedCutoff = fakeNow - 1_000;
    const listingCutoffs: number[] = [];
    let page = 0;
    const fakeStore = new Proxy(store, {
      get(target, property) {
        if (property === 'listJobs') {
          return async (options: { staleAfterMs?: number } = {}) => {
            listingCutoffs.push(fakeNow - (options.staleAfterMs ?? 0));
            const listed = pages[page++] ?? [];
            fakeNow += 5_000;
            return listed;
          };
        }
        if (property === 'finalizeAbandonedIfStale') {
          return async (jobId: string, _before: Date, reason: string): Promise<EventRecord> => ({
            id: page * 1000 + Number(jobId.split('-').at(-1) ?? 0),
            jobId,
            eventType: 'abandoned',
            data: { type: 'abandoned', reason },
            createdAt: new Date(0),
          });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JobStore;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    try {
      const reconciled = await new JobRunner(fakeStore).reconcileAbandoned(1_000);
      expect(reconciled).toHaveLength(105);
      expect(listingCutoffs).toHaveLength(2);
      expect(listingCutoffs.every((cutoff) => cutoff === expectedCutoff)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('stops after a custom store repeats one wholly rejected stale page', async () => {
    const record: JobRecord = {
      id: 'unchanged',
      name: 'unchanged',
      input: null,
      status: 'STALE',
      result: null,
      error: null,
      eventCount: 0,
      createdAt: new Date(0),
      startedAt: new Date(0),
      completedAt: null,
      ownerId: 'owner-unchanged',
      heartbeatEnabled: true,
      heartbeatAt: new Date(0),
    };
    let listCalls = 0;
    const fakeStore = new Proxy(store, {
      get(target, property) {
        if (property === 'listJobs') return async () => { listCalls += 1; return [record]; };
        if (property === 'finalizeAbandonedIfStale') return async () => null;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JobStore;

    await expect(new JobRunner(fakeStore).reconcileAbandoned(1_000)).resolves.toEqual([]);
    expect(listCalls).toBe(2);
  });

  it('re-queries after a recovered first page and reconciles later stale jobs', async () => {
    const runner = new JobRunner(store);
    const ids: string[] = [];
    for (let index = 0; index < 105; index++) {
      const id = await store.createJob(`recover-page-${index}`, null);
      await store.setRunning(id, { ownerId: `owner-${index}`, heartbeatEnabled: true });
      ids.push(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 2100));

    const originalList = store.listJobs.bind(store);
    const refreshed = new Set<string>();
    let firstPage = true;
    vi.spyOn(store, 'listJobs').mockImplementation(async (options) => {
      const listed = await originalList(options);
      if (firstPage) {
        firstPage = false;
        for (const job of listed) {
          refreshed.add(job.id);
          await store.heartbeat(job.id, job.ownerId);
        }
      }
      return listed;
    });

    const reconciled = await runner.reconcileAbandoned(1000);
    const expected = ids.filter((id) => !refreshed.has(id));
    expect(refreshed.size).toBe(100);
    expect(new Set(reconciled)).toEqual(new Set(expected));
    expect(reconciled).toHaveLength(5);
    for (const id of expected) {
      expect((await store.getJob(id))?.status).toBe('ABANDONED');
    }
  });

  it('does not abandon a stale-listed owner that heartbeats before the atomic transition', async () => {
    const runner = new JobRunner(store);
    const id = await store.createJob('recovered-owner', null);
    await store.setRunning(id, { ownerId: 'owner-live', heartbeatEnabled: true });
    await new Promise((r) => setTimeout(r, 2100));

    const originalList = store.listJobs.bind(store);
    vi.spyOn(store, 'listJobs').mockImplementation(async (options) => {
      const listed = await originalList(options);
      await store.heartbeat(id);
      return listed;
    });

    await expect(runner.reconcileAbandoned(1000)).resolves.toEqual([]);
    expect((await store.getJob(id))?.status).toBe('RUNNING');
  });

  it('COMPLETED / FAILED rows are never reported as STALE regardless of heartbeat age', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id);
    await store.setCompleted(id, { ok: true });
    await new Promise((r) => setTimeout(r, 1100));
    const job = await store.getJob(id, { staleAfterMs: 100 });
    expect(job?.status).toBe('COMPLETED');
  });
});
