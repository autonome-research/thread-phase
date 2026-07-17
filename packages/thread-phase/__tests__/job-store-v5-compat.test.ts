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
  it('has void lifecycle returns and no unreleased ownership methods', async () => {
    const store = new V5CustomJobStore();
    const jobId = await store.createJob('minimal-v5', null);

    await expect(store.setRunning(jobId)).resolves.toBeUndefined();
    await expect(store.heartbeat(jobId)).resolves.toBeUndefined();
    await expect(store.setCompleted(jobId, null)).resolves.toBeUndefined();
    expect(store.close()).toBeUndefined();
    expect('claimRunning' in store).toBe(false);
    expect('finalizeJob' in store).toBe(false);
    expect('finalizeAbandonedIfStale' in store).toBe(false);
    expect('heartbeatOwned' in store).toBe(false);
    expect('enableHeartbeat' in store).toBe(false);
  });

  it('runs successfully using only the unchanged v5.0.0 interface', async () => {
    const store = new V5CustomJobStore();
    const runner = new JobRunner(store);
    const jobId = await runner.create('legacy', null);

    await expect(runner.run(jobId, [successfulPhase], { cache: new PipelineCache() }))
      .resolves.toEqual({ status: 'completed', eventCount: 2 });
    expect(await store.getJob(jobId)).toMatchObject({ status: 'COMPLETED' });
    expect((await store.getEvents(jobId)).map((event) => event.eventType))
      .toEqual(['data', 'done']);
  });

  it('falls back to legacy failure persistence without requiring new methods', async () => {
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
