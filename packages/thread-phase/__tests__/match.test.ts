/**
 * match — keyed dispatch over phases.
 */

import { describe, it, expect } from 'vitest';
import { match } from '../src/patterns/match.js';
import { PipelineCache } from '../src/cache.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  intent?: 'bug' | 'feature' | 'question';
  taken?: string;
  log?: string[];
}

const makeCtx = (intent?: Ctx['intent']): Ctx => ({
  cache: new PipelineCache(),
  intent,
  log: [],
});

const tagPhase = (name: string): Phase<Ctx> => ({
  name,
  async *run(ctx) {
    ctx.log?.push(name);
    yield { type: 'phase', phase: name };
  },
});

describe('match', () => {
  it('routes to the case matching the selector key', async () => {
    const m = match<Ctx, 'bug' | 'feature' | 'question'>('route', {
      selector: (ctx) => ctx.intent ?? null,
      cases: {
        bug: [tagPhase('reproduce'), tagPhase('assign')],
        feature: [tagPhase('triage')],
        question: [tagPhase('respond-faq')],
      },
    });

    const ctx = makeCtx('bug');
    const events: PipelineEvent[] = [];
    for await (const ev of m.run(ctx)) events.push(ev);

    expect(ctx.log).toEqual(['reproduce', 'assign']);
    const taken = events.find((e) => e.type === 'data' && e.key === 'route.taken');
    expect((taken as { value: { taken: string } }).value.taken).toBe('bug');
  });

  it('falls through to default when key has no case', async () => {
    const m = match<Ctx, 'bug' | 'feature'>('route', {
      selector: () => 'feature',
      cases: { bug: [tagPhase('bug')], feature: [tagPhase('feature')] },
      default: [tagPhase('fallback')],
    });

    const ctx = makeCtx();
    for await (const _ of m.run(ctx)) {
      // drain
    }

    expect(ctx.log).toEqual(['feature']);
  });

  it('runs default when selector returns an unknown key', async () => {
    const m = match<Ctx, 'a' | 'b' | 'c'>('route', {
      // selector deliberately returns 'c', which is not in cases
      selector: () => 'c',
      cases: {
        a: [tagPhase('a')],
        b: [tagPhase('b')],
      } as Record<'a' | 'b' | 'c', Phase<Ctx>[]>,
      default: [tagPhase('default')],
    });

    // Replace cases to simulate "key in type, missing at runtime"
    // by passing a partial cases record:
    const m2 = match<Ctx, 'a' | 'b' | 'c'>('route', {
      selector: () => 'c',
      cases: {
        a: [tagPhase('a')],
        b: [tagPhase('b')],
      } as unknown as Record<'a' | 'b' | 'c', Phase<Ctx>[]>,
      default: [tagPhase('default')],
    });

    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of m2.run(ctx)) events.push(ev);

    expect(ctx.log).toEqual(['default']);
    const taken = events.find((e) => e.type === 'data' && e.key === 'route.taken');
    expect((taken as { value: { taken: string } }).value.taken).toBe('default');
    // Silence unused-var lints
    void m;
  });

  it('skips silently when selector returns null', async () => {
    const m = match<Ctx, 'bug' | 'feature'>('route', {
      selector: () => null,
      cases: { bug: [tagPhase('bug')], feature: [tagPhase('feature')] },
      default: [tagPhase('default')],
    });

    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of m.run(ctx)) events.push(ev);

    expect(ctx.log).toEqual([]);
    const taken = events.find((e) => e.type === 'data' && e.key === 'route.taken');
    expect((taken as { value: { taken: string } }).value.taken).toBe('skip');
  });

  it('skips silently when key has no case and no default', async () => {
    const m = match<Ctx, 'a' | 'b' | 'c'>('route', {
      selector: () => 'c',
      cases: {
        a: [tagPhase('a')],
        b: [tagPhase('b')],
      } as unknown as Record<'a' | 'b' | 'c', Phase<Ctx>[]>,
    });

    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of m.run(ctx)) events.push(ev);

    expect(ctx.log).toEqual([]);
    const taken = events.find((e) => e.type === 'data' && e.key === 'route.taken');
    expect((taken as { value: { taken: string } }).value.taken).toBe('skip');
  });

  it('supports async selectors', async () => {
    const m = match<Ctx, 'bug' | 'feature'>('route', {
      selector: async (ctx) => {
        await new Promise<void>((r) => setTimeout(r, 1));
        return ctx.intent === 'bug' ? 'bug' : 'feature';
      },
      cases: { bug: [tagPhase('bug')], feature: [tagPhase('feature')] },
    });

    const ctx = makeCtx('bug');
    for await (const _ of m.run(ctx)) {
      // drain
    }

    expect(ctx.log).toEqual(['bug']);
  });

  it('halts on ctx.stop set inside a case', async () => {
    const halt: Phase<Ctx> = {
      name: 'halt',
      async *run(ctx) {
        ctx.stop = { reason: 'halted from case' };
        ctx.log?.push('halt');
        yield { type: 'phase', phase: 'halt' };
      },
    };

    const m = match<Ctx, 'a' | 'b'>('route', {
      selector: () => 'a',
      cases: {
        a: [halt, tagPhase('after-halt')],
        b: [tagPhase('b')],
      },
    });

    const ctx = makeCtx();
    for await (const _ of m.run(ctx)) {
      // drain
    }

    expect(ctx.log).toEqual(['halt']);
    expect(ctx.stop).toEqual({ reason: 'halted from case' });
  });

  it('case-key emits taken: <key>', async () => {
    const m = match<Ctx, 'bug' | 'feature'>('route', {
      selector: () => 'feature',
      cases: { bug: [tagPhase('bug')], feature: [tagPhase('feature')] },
    });

    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of m.run(ctx)) events.push(ev);

    const taken = events.find((e) => e.type === 'data' && e.key === 'route.taken');
    expect((taken as { value: { taken: string } }).value.taken).toBe('feature');
  });
});
