/**
 * subPipeline — composing a registered or inline pipeline as a phase
 * inside another pipeline. Tests cover the higher-order pattern form
 * and the free-function runSubPipeline form.
 */

import { describe, it, expect } from 'vitest';
import {
  subPipeline,
  runSubPipeline,
} from '../src/patterns/sub-pipeline.js';
import { runPipeline } from '../src/orchestrator.js';
import { PipelineCache } from '../src/cache.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';

interface OuterCtx extends BasePipelineContext {
  outerVisited?: string[];
  innerResult?: string;
}

interface InnerCtx extends BasePipelineContext {
  innerVisited?: string[];
  innerOut?: string;
}

const recordOuter = (name: string): Phase<OuterCtx> => ({
  name,
  async *run(ctx) {
    ctx.outerVisited = [...(ctx.outerVisited ?? []), name];
    yield { type: 'phase', phase: name };
  },
});

const recordInner = (name: string, sets?: string): Phase<InnerCtx> => ({
  name,
  async *run(ctx) {
    ctx.innerVisited = [...(ctx.innerVisited ?? []), name];
    if (sets) ctx.innerOut = sets;
    yield { type: 'phase', phase: name };
  },
});

async function collect(gen: AsyncGenerator<PipelineEvent>): Promise<PipelineEvent[]> {
  const out: PipelineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('subPipeline (pattern)', () => {
  it('runs an inline inner pipeline and emits its events through the outer stream', async () => {
    const outerCtx: OuterCtx = { cache: new PipelineCache() };

    const innerPipeline = {
      phases: [recordInner('inner-1'), recordInner('inner-2')],
      ctx: { cache: new PipelineCache() } as InnerCtx,
    };

    const phases: Phase<OuterCtx>[] = [
      recordOuter('outer-pre'),
      subPipeline<OuterCtx, InnerCtx>('use-inner', {
        pipeline: innerPipeline,
      }),
      recordOuter('outer-post'),
    ];

    const events = await collect(runPipeline(phases, outerCtx));

    expect(outerCtx.outerVisited).toEqual(['outer-pre', 'outer-post']);
    // Inner events flatten into the outer stream — verify the order:
    const phaseEvents = events
      .filter((e) => e.type === 'phase')
      .map((e) => (e as { phase: string }).phase);
    expect(phaseEvents).toEqual([
      'outer-pre',
      'inner-1',
      'inner-2',
      'outer-post',
    ]);
  });

  it('accepts a lazy resolver and calls it each invocation', async () => {
    let resolveCalls = 0;
    const resolver = (): { phases: ReadonlyArray<Phase<InnerCtx>>; ctx: InnerCtx } => {
      resolveCalls++;
      return {
        phases: [recordInner('resolved')],
        ctx: { cache: new PipelineCache() } as InnerCtx,
      };
    };

    const outerCtx: OuterCtx = { cache: new PipelineCache() };
    const phases: Phase<OuterCtx>[] = [
      subPipeline<OuterCtx, InnerCtx>('via-resolver', { pipeline: resolver }),
      subPipeline<OuterCtx, InnerCtx>('via-resolver-2', { pipeline: resolver }),
    ];

    await collect(runPipeline(phases, outerCtx));
    expect(resolveCalls).toBe(2);
  });

  it('throws when the resolver returns undefined', async () => {
    const outerCtx: OuterCtx = { cache: new PipelineCache() };
    const phases: Phase<OuterCtx>[] = [
      subPipeline<OuterCtx, InnerCtx>('missing', { pipeline: () => undefined }),
    ];

    await expect(collect(runPipeline(phases, outerCtx))).rejects.toThrow(
      /subPipeline "missing": pipeline resolver returned undefined/,
    );
  });

  it('uses mapInput to shape the inner ctx', async () => {
    interface SeededInner extends BasePipelineContext {
      seed: number;
      doubled?: number;
    }

    const doubler: Phase<SeededInner> = {
      name: 'double',
      async *run(ctx) {
        ctx.doubled = ctx.seed * 2;
        yield { type: 'data', key: 'doubled', value: ctx.doubled };
      },
    };

    interface OuterWithVal extends BasePipelineContext {
      value: number;
      result?: number;
    }

    const outerCtx: OuterWithVal = { cache: new PipelineCache(), value: 21 };

    const events = await collect(
      runPipeline(
        [
          subPipeline<OuterWithVal, SeededInner>('double-it', {
            pipeline: { phases: [doubler], ctx: { cache: new PipelineCache(), seed: 0 } },
            mapInput: (outer) => ({ cache: new PipelineCache(), seed: outer.value }),
          }),
        ],
        outerCtx,
      ),
    );

    const dataEvent = events.find(
      (e) => e.type === 'data' && e.key === 'doubled',
    ) as { value: number } | undefined;
    expect(dataEvent?.value).toBe(42);
  });

  it('uses mapOutput to merge inner state back into outer ctx', async () => {
    interface InnerOut extends BasePipelineContext {
      tally: number;
    }
    interface OuterOut extends BasePipelineContext {
      from_inner?: number;
    }

    const counter: Phase<InnerOut> = {
      name: 'count',
      async *run(ctx) {
        ctx.tally = 99;
        yield { type: 'phase', phase: 'count' };
      },
    };

    const outerCtx: OuterOut = { cache: new PipelineCache() };

    await collect(
      runPipeline(
        [
          subPipeline<OuterOut, InnerOut>('count-and-merge', {
            pipeline: { phases: [counter], ctx: { cache: new PipelineCache(), tally: 0 } },
            mapOutput: (outer, inner) => {
              outer.from_inner = inner.tally;
            },
          }),
        ],
        outerCtx,
      ),
    );

    expect(outerCtx.from_inner).toBe(99);
  });

  it('propagates the outer signal so phases can observe cancellation', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;

    interface Sig extends BasePipelineContext {
      done?: boolean;
    }

    const observer: Phase<Sig> = {
      name: 'observer',
      async *run(ctx) {
        observedSignal = ctx.signal;
        yield { type: 'phase', phase: 'observer' };
      },
    };

    const outerCtx: BasePipelineContext = {
      cache: new PipelineCache(),
      signal: controller.signal,
    };

    await collect(
      runPipeline(
        [
          subPipeline<BasePipelineContext, Sig>('observe', {
            pipeline: { phases: [observer], ctx: { cache: new PipelineCache() } },
          }),
        ],
        outerCtx,
      ),
    );

    expect(observedSignal).toBe(controller.signal);
  });

  it('halts cleanly when the inner pipeline sets ctx.stop', async () => {
    interface S extends BasePipelineContext {}

    const stopper: Phase<S> = {
      name: 'stopper',
      async *run(ctx) {
        ctx.stop = { reason: 'inner-halt' };
        yield { type: 'phase', phase: 'stopper' };
      },
    };

    const outerCtx: OuterCtx = { cache: new PipelineCache() };

    const events = await collect(
      runPipeline(
        [
          subPipeline<OuterCtx, S>('inner-with-stop', {
            pipeline: { phases: [stopper], ctx: { cache: new PipelineCache() } },
          }),
          recordOuter('outer-after'),
        ],
        outerCtx,
      ),
    );

    // The outer pipeline keeps going — only the inner halts.
    expect(outerCtx.outerVisited).toEqual(['outer-after']);
    expect(events.some((e) => e.type === 'done' && (e as { reason?: string }).reason === 'inner-halt')).toBe(true);
  });
});

describe('runSubPipeline (free function)', () => {
  it('returns { ctx, summary } on success', async () => {
    interface S extends BasePipelineContext {
      ran?: boolean;
    }
    const work: Phase<S> = {
      name: 'work',
      async *run(ctx) {
        ctx.ran = true;
        yield { type: 'phase', phase: 'work' };
      },
    };

    const { ctx, summary } = await runSubPipeline<S>({
      phases: [work],
      ctx: { cache: new PipelineCache() },
    });

    expect(ctx.ran).toBe(true);
    expect(summary).toEqual({ status: 'completed', eventCount: 2 });
  });

  it('rejects when an inner phase throws', async () => {
    interface S extends BasePipelineContext {}
    const boom: Phase<S> = {
      name: 'boom',
      async *run() {
        throw new Error('inner failure');
        yield { type: 'phase', phase: 'boom' };
      },
    };

    await expect(
      runSubPipeline<S>({
        phases: [boom],
        ctx: { cache: new PipelineCache() },
      }),
    ).rejects.toThrow(/inner failure/);
  });
});
