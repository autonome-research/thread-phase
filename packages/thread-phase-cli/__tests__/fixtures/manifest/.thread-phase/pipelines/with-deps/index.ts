import { PipelineCache } from '@autonome-research/thread-phase';
import type { BasePipelineContext, Phase } from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface Ctx extends BasePipelineContext {}
const noop: Phase<Ctx> = {
  name: 'noop',
  async *run() {
    yield { type: 'phase', phase: 'noop' };
  },
};

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<Ctx, void>('with-deps', {
    phases: [noop],
    ctx: { cache: new PipelineCache() },
    description: 'fixture: pipeline declared via package.json manifest',
  });
};
