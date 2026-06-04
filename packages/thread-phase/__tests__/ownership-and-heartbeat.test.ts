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

  it('JobRunner with heartbeatMs fires the background timer during run()', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 50 });
    const id = await runner.create('p1', null);
    const heartbeatSpy = vi.spyOn(store, 'heartbeat');
    const phase: Phase<BasePipelineContext> = {
      name: 'slow',
      async *run() {
        await new Promise((r) => setTimeout(r, 200));
      },
    };
    await runner.run(id, [phase], { cache: new PipelineCache() });
    // At least one auto-heartbeat fired during the 200ms phase.
    expect(heartbeatSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('JobRunner clears the heartbeat timer on every exit path (success)', async () => {
    const runner = new JobRunner(store, { heartbeatMs: 50 });
    const id = await runner.create('p1', null);
    const phase: Phase<BasePipelineContext> = { name: 'noop', async *run() {} };
    await runner.run(id, [phase], { cache: new PipelineCache() });
    const callsAtFinish = vi.spyOn(store, 'heartbeat').mock.calls.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(vi.spyOn(store, 'heartbeat').mock.calls.length).toBe(callsAtFinish);
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
  it('getJob with staleAfterMs reports STALE when RUNNING + heartbeat expired', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id);
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
    await store.setRunning(id);
    await new Promise((r) => setTimeout(r, 1100));
    // Read once with staleAfterMs (would report STALE).
    await store.getJob(id, { staleAfterMs: 500 });
    // Read again WITHOUT staleAfterMs — persisted status is unchanged.
    const job = await store.getJob(id);
    expect(job?.status).toBe('RUNNING');
  });

  it('listJobs with staleAfterMs returns STALE rows; default reads return RUNNING', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id);
    await new Promise((r) => setTimeout(r, 1100));
    const plain = await store.listJobs();
    expect(plain[0]?.status).toBe('RUNNING');
    const withStaleness = await store.listJobs({ staleAfterMs: 1000 });
    expect(withStaleness[0]?.status).toBe('STALE');
  });

  it('listJobs status:STALE + staleAfterMs filters to only stale rows', async () => {
    const stale = await store.createJob('p1', null);
    await store.setRunning(stale);
    const fresh = await store.createJob('p2', null);
    await store.setRunning(fresh);
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

  it('COMPLETED / FAILED rows are never reported as STALE regardless of heartbeat age', async () => {
    const id = await store.createJob('p1', null);
    await store.setRunning(id);
    await store.setCompleted(id, { ok: true });
    await new Promise((r) => setTimeout(r, 1100));
    const job = await store.getJob(id, { staleAfterMs: 100 });
    expect(job?.status).toBe('COMPLETED');
  });
});
