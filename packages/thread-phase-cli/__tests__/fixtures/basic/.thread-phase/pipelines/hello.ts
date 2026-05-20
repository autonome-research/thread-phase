import { PipelineCache } from '@autonome-research/thread-phase';
import type { BasePipelineContext, Phase } from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface Ctx extends BasePipelineContext {
  greeting?: string;
}

const greet: Phase<Ctx> = {
  name: 'greet',
  async *run(ctx) {
    ctx.greeting = 'hello from fixture';
    yield { type: 'data', key: 'greeting', value: ctx.greeting };
  },
};

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<Ctx, void>('hello', {
    phases: [greet],
    ctx: { cache: new PipelineCache() },
    description: 'fixture: a tiny greeting pipeline',
  });

  api.registerPipeline<Ctx, void>('hello-on-timer', {
    phases: [greet],
    ctx: () => ({ cache: new PipelineCache() }),
    trigger: 'timer-fast',
    description: 'fixture: greeting fired by timer-fast',
  });
};
