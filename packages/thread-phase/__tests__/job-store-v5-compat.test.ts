import { describe, expect, it } from 'vitest';
import { PipelineCache } from '../src/cache.js';
import type { BasePipelineContext, Phase } from '../src/phase.js';
import { JobRunner } from '../src/session/job-runner.js';
import { V5CustomJobStore } from '../test-d/job-store-v5.js';

interface Ctx extends BasePipelineContext {}

describe('exact v5.0.0 custom JobStore compatibility', () => {
  it('preserves released CAS returns and owner-aware direct-store signatures', async () => {
    const store = new V5CustomJobStore();
    const id = await store.createJob('owned', null);

    await expect(store.setRunning(id, { ownerId: 'owner-a' })).resolves.toBe(true);
    await expect(store.setRunning(id, { ownerId: 'owner-b' })).resolves.toBe(false);
    await expect(store.enableHeartbeat(id, 'foreign')).resolves.toBe(false);
    await expect(store.enableHeartbeat(id, 'owner-a')).resolves.toBe(true);
    await expect(store.setCompleted(id, { wrong: true }, 'owner-b')).resolves.toBe(false);
    await expect(store.setCompleted(id, { ok: true }, 'owner-a')).resolves.toBe(true);
    await expect(store.setFailed(id, 'late', 'owner-a')).resolves.toBe(false);

    expect(await store.getJob(id)).toMatchObject({
      status: 'COMPLETED',
      result: { ok: true },
      error: null,
      ownerId: 'owner-a',
    });
  });

  it('supports direct atomic terminal state and event finalization', async () => {
    const store = new V5CustomJobStore();
    const id = await store.createJob('finalized', null);
    await store.setRunning(id, { ownerId: 'owner' });

    await expect(store.finalizeJob(id, {
      status: 'FAILED',
      error: 'boom',
      event: { type: 'error', message: 'boom' },
      ownerId: 'owner',
    })).resolves.toMatchObject({ eventType: 'error', jobId: id });
    await expect(store.finalizeJob(id, {
      status: 'COMPLETED',
      event: { type: 'done' },
      ownerId: 'owner',
    })).resolves.toBeNull();
    expect(await store.getJob(id)).toMatchObject({ status: 'FAILED', error: 'boom' });
    expect((await store.getEvents(id)).map((event) => event.eventType)).toEqual(['error']);
  });

  it('runs success and failure lifecycles against the structural custom store', async () => {
    const store = new V5CustomJobStore();
    const runner = new JobRunner(store);
    const successId = await runner.create('success', null);
    const success: Phase<Ctx> = {
      name: 'success',
      async *run(ctx) {
        await ctx.heartbeat?.();
        yield { type: 'data', key: 'custom-store', value: true };
      },
    };

    await expect(runner.run(successId, [success], { cache: new PipelineCache() }))
      .resolves.toEqual({ status: 'completed', eventCount: 2 });
    expect(await store.getJob(successId)).toMatchObject({ status: 'COMPLETED' });
    expect((await store.getEvents(successId)).map((event) => event.eventType))
      .toEqual(['data', 'done']);

    const failureId = await runner.create('failure', null);
    const failure: Phase<Ctx> = {
      name: 'failure',
      async *run() {
        throw new Error('custom-store boom');
      },
    };
    await expect(runner.run(failureId, [failure], { cache: new PipelineCache() }))
      .rejects.toThrow('custom-store boom');
    expect(await store.getJob(failureId)).toMatchObject({
      status: 'FAILED',
      error: 'custom-store boom',
    });
    expect((await store.getEvents(failureId)).map((event) => event.eventType)).toEqual(['error']);
  });
});
