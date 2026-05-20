/**
 * timer + JobRunner — persistent pipeline runs.
 *
 * Each trigger fire creates a job row in the JobStore and runs through
 * JobRunner, so pipeline events end up in the event log and the
 * job's outcome (status, duration, error) is durable.
 *
 * Run: npx tsx examples/triggers/timer-with-job-runner.ts
 */

import { unlinkSync, existsSync } from 'node:fs';
import {
  PipelineCache,
  JobRunner,
  SqliteJobStore,
  type BasePipelineContext,
  type Phase,
} from '../../src/index.js';
import { TimerTrigger, runTrigger } from '../../src/triggers/index.js';

interface Ctx extends BasePipelineContext {
  index: number;
}

const work: Phase<Ctx> = {
  name: 'work',
  async *run(ctx) {
    yield { type: 'phase', phase: 'work', detail: `tick ${ctx.index}` };
    yield { type: 'data', key: 'result', value: ctx.index * 2 };
  },
};

const dbPath = '/tmp/thread-phase-trigger-example.db';
if (existsSync(dbPath)) unlinkSync(dbPath);

const store = new SqliteJobStore(dbPath);
const runner = new JobRunner(store);
let index = 0;

const trigger = new TimerTrigger<number>({
  intervalMs: 300,
  fireImmediately: true,
  payload: () => ++index,
});

const handle = runTrigger(
  trigger,
  (input) => ({
    phases: [work],
    ctx: { cache: new PipelineCache(), index: input },
  }),
  {
    jobRunner: runner,
    jobStore: store,
    pipelineName: 'timer-pipeline',
    onComplete: (event, jobId) =>
      console.log(`event ${event.id} → job ${jobId} done`),
  },
);

setTimeout(() => void handle.stop(), 1500);
await handle.done;

console.log('\nPersisted jobs:');
for (const job of store.listJobs({ limit: 10 })) {
  console.log(
    `  ${job.id.slice(0, 8)}  ${job.status}  ${job.eventCount} events  index=${
      (job.input as { triggerEventId: number }).triggerEventId
    }`,
  );
}

store.close();
unlinkSync(dbPath);
