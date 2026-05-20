/**
 * Pipeline extension — uses a shared user-side pattern from `../lib/`.
 *
 * Demonstrates the convention for shared code: `pollUntil` lives under
 * `.thread-phase/lib/poll-until.ts` and is imported here via a relative
 * path. The file under lib/ is NOT auto-loaded — it's plain TypeScript
 * that pipelines reach into.
 *
 * The pipeline polls a fake job status until it reports `done`, then
 * records the final status.
 */

import { PipelineCache } from '@autonome-research/thread-phase';
import type {
  BasePipelineContext,
  Phase,
} from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

import { pollUntil } from '../lib/poll-until.js';

interface PollCtx extends BasePipelineContext {
  attempts: number;
  status: 'pending' | 'running' | 'done';
}

const probeJob: Phase<PollCtx> = {
  name: 'probe-job',
  async *run(ctx) {
    ctx.attempts += 1;
    // Stub: pretend a remote job finishes after 3 probes.
    ctx.status = ctx.attempts >= 3 ? 'done' : 'running';
    yield {
      type: 'data',
      key: 'probe',
      value: { attempts: ctx.attempts, status: ctx.status },
    };
  },
};

const waitForJob = pollUntil<PollCtx>('wait-for-job', {
  probe: probeJob,
  done: (ctx) => ctx.status === 'done',
  maxIterations: 10,
});

const recordResult: Phase<PollCtx> = {
  name: 'record-result',
  async *run(ctx) {
    yield {
      type: 'data',
      key: 'final',
      value: { attempts: ctx.attempts, status: ctx.status },
    };
  },
};

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<PollCtx, void>('poll-job', {
    phases: [waitForJob, recordResult],
    ctx: () => ({
      cache: new PipelineCache(),
      attempts: 0,
      status: 'pending',
    }),
    description:
      'polls a stub job via pollUntil (shared pattern from .thread-phase/lib/)',
  });
};
