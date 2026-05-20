/**
 * whileCondition — convergence loop pattern.
 */

import { describe, it, expect } from 'vitest';
import { whileCondition } from '../src/patterns/while-condition.js';
import { PipelineCache } from '../src/cache.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  count?: number;
  log?: string[];
}

const makeCtx = (): Ctx => ({ cache: new PipelineCache(), count: 0, log: [] });

const incrementPhase: Phase<Ctx> = {
  name: 'increment',
  async *run(ctx) {
    ctx.count = (ctx.count ?? 0) + 1;
    ctx.log?.push(`tick ${ctx.count}`);
    yield { type: 'phase', phase: 'increment', detail: `${ctx.count}` };
  },
};

describe('whileCondition', () => {
  it('runs body until predicate returns false', async () => {
    const loop = whileCondition<Ctx>('loop', {
      predicate: (ctx) => (ctx.count ?? 0) < 3,
      body: [incrementPhase],
      maxIterations: 10,
    });

    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of loop.run(ctx)) events.push(ev);

    expect(ctx.count).toBe(3);
    const converged = events.find(
      (e) => e.type === 'data' && e.key === 'loop.converged',
    );
    expect(converged).toBeDefined();
    expect((converged as { value: { iterations: number } }).value.iterations).toBe(3);
    expect(ctx.stop).toBeUndefined();
  });

  it('produces zero body executions when predicate is initially false', async () => {
    const loop = whileCondition<Ctx>('loop', {
      predicate: () => false,
      body: [incrementPhase],
    });

    const ctx = makeCtx();
    for await (const _ of loop.run(ctx)) {
      // drain
    }

    expect(ctx.count).toBe(0);
    expect(ctx.stop).toBeUndefined();
  });

  it('hits the max-iteration cap and sets ctx.stop', async () => {
    const loop = whileCondition<Ctx>('loop', {
      predicate: () => true,
      body: [incrementPhase],
      maxIterations: 4,
    });

    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of loop.run(ctx)) events.push(ev);

    expect(ctx.count).toBe(4);
    expect(ctx.stop).toEqual({ reason: 'loop: max iterations (4) reached' });
    const cap = events.find(
      (e) => e.type === 'data' && e.key === 'loop.max-iterations',
    );
    expect(cap).toBeDefined();
  });

  it('halts immediately when the body sets ctx.stop', async () => {
    const halt: Phase<Ctx> = {
      name: 'halt',
      async *run(ctx) {
        ctx.stop = { reason: 'halt requested' };
        yield { type: 'phase', phase: 'halt' };
      },
    };

    const loop = whileCondition<Ctx>('loop', {
      predicate: () => true,
      body: [incrementPhase, halt],
      maxIterations: 10,
    });

    const ctx = makeCtx();
    for await (const _ of loop.run(ctx)) {
      // drain
    }

    expect(ctx.count).toBe(1);
    expect(ctx.stop).toEqual({ reason: 'halt requested' });
  });

  it('supports async predicates', async () => {
    let resolveCount = 0;
    const loop = whileCondition<Ctx>('loop', {
      predicate: async (ctx) => {
        resolveCount++;
        await new Promise<void>((r) => setTimeout(r, 1));
        return (ctx.count ?? 0) < 2;
      },
      body: [incrementPhase],
    });

    const ctx = makeCtx();
    for await (const _ of loop.run(ctx)) {
      // drain
    }

    expect(ctx.count).toBe(2);
    expect(resolveCount).toBe(3); // 2 true + 1 false
  });

  it('defaults maxIterations to 10', async () => {
    const loop = whileCondition<Ctx>('loop', {
      predicate: () => true,
      body: [incrementPhase],
    });

    const ctx = makeCtx();
    for await (const _ of loop.run(ctx)) {
      // drain
    }

    expect(ctx.count).toBe(10);
    expect(ctx.stop?.reason).toContain('max iterations (10)');
  });

  it('runs body phases sequentially within an iteration', async () => {
    const a: Phase<Ctx> = {
      name: 'a',
      async *run(ctx) {
        ctx.log?.push('a');
        yield { type: 'phase', phase: 'a' };
      },
    };
    const b: Phase<Ctx> = {
      name: 'b',
      async *run(ctx) {
        ctx.log?.push('b');
        yield { type: 'phase', phase: 'b' };
      },
    };

    let n = 0;
    const loop = whileCondition<Ctx>('loop', {
      predicate: () => n++ < 2,
      body: [a, b],
    });

    const ctx = makeCtx();
    for await (const _ of loop.run(ctx)) {
      // drain
    }

    expect(ctx.log).toEqual(['a', 'b', 'a', 'b']);
  });
});
