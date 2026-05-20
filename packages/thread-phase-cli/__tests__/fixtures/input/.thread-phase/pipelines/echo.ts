import { PipelineCache } from '@autonome-research/thread-phase';
import type { BasePipelineContext, Phase } from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface Ctx extends BasePipelineContext {
  echoed?: unknown;
}

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<Ctx, unknown>('echo', {
    phases: (input) => [
      {
        name: 'echo',
        async *run(ctx) {
          ctx.echoed = input;
          yield { type: 'data', key: 'echoed', value: JSON.stringify(input) };
        },
      } satisfies Phase<Ctx>,
    ],
    ctx: () => ({ cache: new PipelineCache() }),
    defaultInput: { source: 'default' },
    description: 'echoes its input back as JSON',
  });
};
