/**
 * Pipeline extension — demonstrates subPipeline composition via lazy
 * registry lookup.
 *
 * `composed` invokes the `minimal` pipeline (also in this corpus) as one of
 * its steps. The inner pipeline gets a fresh cache, observes the same
 * cancellation signal, and merges a flag back into the outer ctx via
 * mapOutput.
 *
 * Run: thread-phase run composed
 */

import { PipelineCache } from '@autonome-research/thread-phase';
import { subPipeline } from '@autonome-research/thread-phase/patterns';
import type {
  BasePipelineContext,
  Phase,
} from '@autonome-research/thread-phase';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

interface OuterCtx extends BasePipelineContext {
  innerRan: boolean;
  finalMessage?: string;
}

interface InnerCtx extends BasePipelineContext {
  message?: string;
}

const announce: Phase<OuterCtx> = {
  name: 'announce',
  async *run() {
    yield { type: 'phase', phase: 'announce', detail: 'about to invoke minimal' };
  },
};

const final: Phase<OuterCtx> = {
  name: 'final',
  async *run(ctx) {
    ctx.finalMessage = ctx.innerRan
      ? 'composed: inner ran ✓'
      : 'composed: inner did NOT run';
    yield { type: 'data', key: 'final', value: ctx.finalMessage };
  },
};

export default (api: ThreadPhaseAPI) => {
  api.registerPipeline<OuterCtx, void>('composed', {
    phases: [
      announce,
      // Look up the 'minimal' pipeline lazily at dispatch time. Late binding
      // means registration order between extensions doesn't matter — minimal
      // can register before or after composed.
      subPipeline<OuterCtx, InnerCtx>('use-minimal', {
        pipeline: () => {
          const spec = api.getPipeline('minimal');
          if (!spec) return undefined;
          // The registered pipeline's phases/ctx may be factories. Materialize
          // them with default input for the sub-call.
          const phases =
            typeof spec.phases === 'function'
              ? (spec.phases as (i: unknown, e: never) => ReadonlyArray<Phase<InnerCtx>>)(
                  undefined,
                  undefined as never,
                )
              : (spec.phases as ReadonlyArray<Phase<InnerCtx>>);
          const ctx =
            typeof spec.ctx === 'function'
              ? (spec.ctx as (i: unknown, e: never) => InnerCtx)(
                  undefined,
                  undefined as never,
                )
              : (spec.ctx as InnerCtx);
          return { phases, ctx };
        },
        mapInput: () => ({ cache: new PipelineCache() }),
        mapOutput: (outer, inner) => {
          outer.innerRan = inner.message !== undefined;
        },
      }),
      final,
    ],
    ctx: () => ({ cache: new PipelineCache(), innerRan: false }),
    description:
      'composes minimal as a sub-pipeline; observes inner via mapOutput',
  });
};
