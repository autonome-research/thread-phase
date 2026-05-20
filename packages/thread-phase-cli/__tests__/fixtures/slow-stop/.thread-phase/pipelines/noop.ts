import { PipelineCache } from '@autonome-research/thread-phase';
import type { BasePipelineContext, Phase } from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface Ctx extends BasePipelineContext {}

const noop: Phase<Ctx> = {
  name: 'noop',
  async *run() {
    // nothing
  },
};

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<Ctx, void>('noop', {
    phases: [noop],
    ctx: () => ({ cache: new PipelineCache() }),
    trigger: 'slow-stop',
    description: 'fixture: a noop pipeline bound to slow-stop trigger',
  });
};
