import { describe, expect, it } from 'vitest';
import { PipelineCache } from '../src/cache.js';
import type { BasePipelineContext, Phase } from '../src/phase.js';
import { JobRunner } from '../src/session/job-runner.js';
import { V5CustomJobStore } from '../test-d/job-store-v5.js';

interface Ctx extends BasePipelineContext {}

const successfulPhase: Phase<Ctx> = {
  name: 'legacy-success',
  async *run(ctx) {
    await ctx.heartbeat?.();
    yield { type: 'data', key: 'legacy', value: true };
  },
};

describe('v5.0.0 custom JobStore compatibility', () => {
  it('implements the ownership lifecycle published in v5.0.0', async () => {
    const store = new V5CustomJobStore();
    const jobId = await store.createJob('published-v5', null);

    await expect(store.setRunning(jobId, { ownerId: 'owner' })).resolves.toBe(true);
    await expect(store.enableHeartbeat(jobId, 'owner')).resolves.toBe(true);
    await expect(store.heartbeat(jobId, 'owner')).resolves.toBeUndefined();
    await expect(store.setCompleted(jobId, null, 'owner')).resolves.toBe(true);
    await expect(store.setFailed(jobId, 'late', 'owner')).resolves.toBe(false);
    expect(store.close()).toBeUndefined();
    expect('finalizeJob' in store).toBe(true);
    expect('finalizeAbandonedIfStale' in store).toBe(true);
    expect('enableHeartbeat' in store).toBe(true);
  });

  it('runs successfully using exactly the published v5.0.0 interface', async () => {
    const store = new V5CustomJobStore();
    const runner = new JobRunner(store);
    const jobId = await runner.create('legacy', null);

    await expect(runner.run(jobId, [successfulPhase], { cache: new PipelineCache() }))
      .resolves.toEqual({ status: 'completed', eventCount: 2 });
    expect(await store.getJob(jobId)).toMatchObject({ status: 'COMPLETED' });
    expect((await store.getEvents(jobId)).map((event) => event.eventType))
      .toEqual(['data', 'done']);
  });

  it('uses published atomic failure finalization', async () => {
    const store = new V5CustomJobStore();
    const runner = new JobRunner(store);
    const jobId = await runner.create('legacy-failure', null);
    const failure: Phase<Ctx> = {
      name: 'legacy-failure',
      async *run() {
        throw new Error('legacy boom');
      },
    };

    await expect(runner.run(jobId, [failure], { cache: new PipelineCache() }))
      .rejects.toThrow('legacy boom');
    expect(await store.getJob(jobId)).toMatchObject({ status: 'FAILED', error: 'legacy boom' });
    expect((await store.getEvents(jobId)).map((event) => event.eventType)).toEqual(['error']);
  });
});
