import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk';
import type { TypeSafeClient as CommonJSClient } from '@typesafe-ai/sdk' with { 'resolution-mode': 'require' };
import type { BasePipelineContext, Phase } from '@autonome-research/thread-phase';
import { systemOne } from '@autonome-research/thread-phase/typesafe';

interface Ctx extends BasePipelineContext {
  text: string;
  route?: 'billing' | 'technical';
}
declare const client: TypeSafeClient;
declare const commonJSClient: CommonJSClient;

// SDK ESM and CommonJS entry points expose distinct nominal APIPromise classes.
systemOne('commonjs-client', {
  client: commonJSClient,
  request: () => ({ state: 'test', questions: { ok: noul('OK?') } }),
  onResult: (result) => { const probability: number = result.answers.ok.noul; void probability; },
});

const phase: Phase<Ctx> = systemOne('triage', {
  client,
  request: (ctx: Ctx) => ({
    state: ctx.text,
    questions: {
      route: choice('Which team?', { billing: null, technical: null }),
      urgent: noul('Urgent?'),
      severity: score('How severe?', ['Low', 'High']),
    },
  }),
  onResult: (result, ctx) => {
    ctx.route = result.answers.route.choice;
    const probability: number = result.answers.urgent.noul;
    const level: number = result.answers.severity.score;
    const high: number = result.answers.severity.probabilities['1'];
    // @ts-expect-error only the declared labels may be chosen
    const other: 'sales' = result.answers.route.choice;
    // @ts-expect-error named answers are not widened to a string index signature
    result.answers.unknown;
    // @ts-expect-error Noul is a probability, not a boolean
    const urgent: boolean = result.answers.urgent.noul;
    // @ts-expect-error only the declared rubric levels exist
    result.answers.severity.probabilities['2'];
    // @ts-expect-error the typed context is preserved
    ctx.notAField = 1;
    void [probability, level, high, other, urgent];
  },
  requestOptions: {
    timeout: 1000,
    // @ts-expect-error pipeline cancellation cannot be overridden
    signal: new AbortController().signal,
  },
});
void phase;

// Inline questions also retain their literal criteria without SDK builders.
systemOne('inline', {
  client,
  request: (ctx: Ctx) => ({
    state: ctx.text,
    questions: { route: { type: 'choice', criteria: { yes: null, no: null } } },
  }),
  onResult: (result) => {
    const route: 'yes' | 'no' = result.answers.route.choice;
    // @ts-expect-error unknown criteria are not allowed
    result.answers.route.probabilities.maybe;
    void route;
  },
});
