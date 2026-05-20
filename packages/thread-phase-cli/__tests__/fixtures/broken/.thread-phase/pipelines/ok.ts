import { PipelineCache } from '@autonome-research/thread-phase';
import type { BasePipelineContext } from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface Ctx extends BasePipelineContext {}

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<Ctx, void>('ok', {
    phases: [],
    ctx: { cache: new PipelineCache() },
  });
};
