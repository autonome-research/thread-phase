/**
 * Pipeline extension — triggered, with a factory ctx.
 *
 * Binds to the morning-timer trigger. Each fire builds a fresh ctx
 * (so each run is isolated) and runs a fanout over today's queue.
 *
 * Demonstrates:
 *  - trigger binding via name ('morning-timer')
 *  - factory `ctx` so each fire gets its own state
 *  - using a pattern (boundedFanout) inside the pipeline body
 */

import { PipelineCache } from '@autonome-research/thread-phase';
import { boundedFanout } from '@autonome-research/thread-phase/patterns';
import type {
  BasePipelineContext,
  Phase,
} from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface DigestCtx extends BasePipelineContext {
  items: Array<{ id: string; title: string }>;
  digestedIds: string[];
}

const loadQueue: Phase<DigestCtx> = {
  name: 'load-queue',
  async *run(ctx) {
    // In a real pipeline: query a DB, hit an API, read a file. Here a stub.
    ctx.items = [
      { id: 'a', title: 'first item' },
      { id: 'b', title: 'second item' },
      { id: 'c', title: 'third item' },
    ];
    yield { type: 'data', key: 'queued', value: ctx.items.length };
  },
};

const digestEach: Phase<DigestCtx> = {
  name: 'digest-each',
  async *run(ctx) {
    const digested = await boundedFanout({
      items: ctx.items,
      concurrency: 2,
      runner: async (item) => {
        // Pretend to digest: in real life, call an agent here.
        return `digested:${item.id}`;
      },
    });
    ctx.digestedIds = digested;
    yield { type: 'data', key: 'digested', value: ctx.digestedIds };
  },
};

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<DigestCtx, void>('morning-digest', {
    phases: [loadQueue, digestEach],
    ctx: () => ({
      cache: new PipelineCache(),
      items: [],
      digestedIds: [],
    }),
    trigger: 'morning-timer',
    description: 'triggered by morning-timer; digests today\'s queue',
  });
};
