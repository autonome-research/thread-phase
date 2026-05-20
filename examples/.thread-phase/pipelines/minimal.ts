/**
 * Pipeline extension — the smallest registrable shape.
 *
 * One-shot (no trigger binding): only invokable via `thread-phase run minimal`.
 * Demonstrates the literal `phases` + literal `ctx` form, no factory.
 */

import { PipelineCache } from '@autonome-research/thread-phase';
import type {
  BasePipelineContext,
  Phase,
} from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface Ctx extends BasePipelineContext {
  message?: string;
}

const speak: Phase<Ctx> = {
  name: 'speak',
  async *run(ctx) {
    ctx.message = 'minimal pipeline ran';
    yield { type: 'data', key: 'message', value: ctx.message };
  },
};

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<Ctx, void>('minimal', {
    phases: [speak],
    ctx: { cache: new PipelineCache() },
    description: 'simplest possible pipeline — one phase, one literal ctx',
  });
};
