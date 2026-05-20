/**
 * match example — keyed dispatch.
 *
 * A support-triage pipeline that routes based on an incoming intent label.
 * Bug reports get reproduced and assigned; feature requests get triaged;
 * questions get a fast-answer phase; an unknown label falls through to
 * default (escalate).
 *
 * Run: npx tsx examples/patterns/match.ts
 */

import {
  PipelineCache,
  runPipeline,
  type Phase,
  type BasePipelineContext,
} from '../../src/index.js';
import { match } from '../../src/patterns/index.js';

type Intent = 'bug' | 'feature' | 'question';

interface TriageCtx extends BasePipelineContext {
  intent: Intent | 'unknown';
  log: string[];
}

const phase = (name: string): Phase<TriageCtx> => ({
  name,
  async *run(ctx) {
    ctx.log.push(name);
    yield { type: 'phase', phase: name, detail: 'ran' };
  },
});

const ctx: TriageCtx = {
  cache: new PipelineCache(),
  intent: 'bug',
  log: [],
};

const phases: Phase<TriageCtx>[] = [
  match<TriageCtx, Intent>('triage', {
    selector: (ctx) => (ctx.intent === 'unknown' ? null : ctx.intent),
    cases: {
      bug: [phase('reproduce'), phase('assign-engineer')],
      feature: [phase('triage-feature')],
      question: [phase('respond-faq')],
    },
    default: [phase('escalate')],
  }),
];

for await (const event of runPipeline(phases, ctx)) {
  console.log(JSON.stringify(event));
}

console.log('\nPhases run:', ctx.log);
