/**
 * npm install @typesafe-ai/sdk
 * TYPESAFE_API_KEY=... npx tsx packages/thread-phase/examples/typesafe-triage.ts
 * Makes one paid API request; keep the key in the environment, not pipeline state.
 */
import { choice, noul, score, TypeSafeClient, type SystemOneResult } from '@typesafe-ai/sdk';
import { PipelineCache, requireCtx, runPipeline, type BasePipelineContext } from '@autonome-research/thread-phase';
import { match } from '@autonome-research/thread-phase/patterns';
import { systemOne } from '@autonome-research/thread-phase/typesafe';

const questions = {
  department: choice('Which team should handle this ticket?', { billing: null, technical: null }),
  urgent: noul('Is this time-sensitive?'),
  severity: score('How severe is the problem?', ['Minor inconvenience', 'Blocked', 'Critical outage']),
};
interface Ctx extends BasePipelineContext {
  ticket: string;
  evaluation?: SystemOneResult<typeof questions>;
}
const evaluate = systemOne('triage', {
  client: new TypeSafeClient({ logLevel: 'off' }),
  request: (ctx: Ctx) => ({ state: { ticket: ctx.ticket }, questions }),
  requestOptions: { timeout: 5000, retry: { maxRetries: 1 } },
  onResult: (result, ctx) => { ctx.evaluation = result; },
});
const route = match<Ctx, 'billing' | 'technical' | 'review'>('route', {
  selector: (ctx) => {
    const { department } = requireCtx(ctx, 'evaluation', 'route').answers;
    // This threshold is application policy, not a library default.
    return department.confidence < 0.8 ? 'review' : department.choice;
  },
  cases: {
    billing: [{ name: 'billing', async *run() { yield { type: 'content', content: 'Queue for billing' }; } }],
    technical: [{ name: 'technical', async *run() { yield { type: 'content', content: 'Queue for technical support' }; } }],
    review: [{ name: 'review', async *run(ctx) { ctx.stop = { reason: 'Needs human review' }; } }],
  },
});
const ctx: Ctx = { cache: new PipelineCache(), ticket: 'I was charged twice. Please fix this ASAP.' };

// A total budget, including retries; SDK timeout is per attempt.
for await (const event of runPipeline([evaluate, route], ctx, { signal: AbortSignal.timeout(15_000) })) {
  console.log(event);
}
