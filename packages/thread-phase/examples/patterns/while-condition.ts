/**
 * whileCondition example — a convergence loop.
 *
 * A research-style pipeline that keeps searching until enough sources are
 * collected (or it hits the iteration cap). Each iteration runs a search
 * phase that appends to ctx.sources, then an assessment phase that decides
 * whether coverage is sufficient.
 *
 * Run: npx tsx examples/patterns/while-condition.ts
 */

import {
  PipelineCache,
  runPipeline,
  type Phase,
  type BasePipelineContext,
} from '../../src/index.js';
import { whileCondition } from '../../src/patterns/index.js';

interface ResearchCtx extends BasePipelineContext {
  query: string;
  sources: string[];
  sufficient: boolean;
  finalReport?: string;
}

const search: Phase<ResearchCtx> = {
  name: 'search',
  async *run(ctx) {
    // Pretend to fetch sources. Each iteration adds two.
    const batch = Array.from({ length: 2 }, (_, i) => `source-${ctx.sources.length + i + 1}`);
    ctx.sources.push(...batch);
    yield {
      type: 'data',
      key: 'search.found',
      value: { batch, total: ctx.sources.length },
    };
  },
};

const assess: Phase<ResearchCtx> = {
  name: 'assess',
  async *run(ctx) {
    // Coverage rule: 6+ sources is enough.
    ctx.sufficient = ctx.sources.length >= 6;
    yield {
      type: 'data',
      key: 'assess.coverage',
      value: { total: ctx.sources.length, sufficient: ctx.sufficient },
    };
  },
};

const synthesize: Phase<ResearchCtx> = {
  name: 'synthesize',
  async *run(ctx) {
    ctx.finalReport = `Report on "${ctx.query}" from ${ctx.sources.length} sources: ${ctx.sources.join(', ')}`;
    yield { type: 'data', key: 'report', value: ctx.finalReport };
  },
};

const ctx: ResearchCtx = {
  cache: new PipelineCache(),
  query: 'thread-phase architecture',
  sources: [],
  sufficient: false,
};

const phases: Phase<ResearchCtx>[] = [
  whileCondition<ResearchCtx>('research-loop', {
    predicate: (ctx) => !ctx.sufficient,
    body: [search, assess],
    maxIterations: 5,
  }),
  synthesize,
];

for await (const event of runPipeline(phases, ctx)) {
  console.log(JSON.stringify(event));
}

console.log('\nFinal report:', ctx.finalReport);
