/**
 * parallelPhases — composite phase that runs sub-phases concurrently.
 */

import { describe, it, expect } from 'vitest';
import { parallelPhases } from '../src/patterns/parallel-phases.js';
import { PipelineCache } from '../src/cache.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  outA?: string;
  outB?: string;
  outC?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const makeCtx = (): Ctx => ({ cache: new PipelineCache() });

describe('parallelPhases', () => {
  it('runs sub-phases concurrently and merges events', async () => {
    const phaseA: Phase<Ctx> = {
      name: 'a',
      async *run(ctx) {
        yield { type: 'phase', phase: 'a', detail: 'start' };
        await sleep(20);
        ctx.outA = 'A';
        yield { type: 'phase', phase: 'a', detail: 'end' };
      },
    };
    const phaseB: Phase<Ctx> = {
      name: 'b',
      async *run(ctx) {
        yield { type: 'phase', phase: 'b', detail: 'start' };
        await sleep(10);
        ctx.outB = 'B';
        yield { type: 'phase', phase: 'b', detail: 'end' };
      },
    };
    const composite = parallelPhases('parallel', [phaseA, phaseB]);
    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    const start = Date.now();
    for await (const ev of composite.run(ctx)) events.push(ev);
    const elapsed = Date.now() - start;

    expect(ctx.outA).toBe('A');
    expect(ctx.outB).toBe('B');
    expect(events).toHaveLength(4);
    // Concurrent: should be roughly the longer branch (~20ms), well under
    // the sum (~30ms). Allow slack for CI noise.
    expect(elapsed).toBeLessThan(40);
  });

  it('yields events as they arrive, not in phase-order', async () => {
    // Phase B is faster, so its 'end' event should appear before A's.
    const slow: Phase<Ctx> = {
      name: 'slow',
      async *run() {
        yield { type: 'phase', phase: 'slow', detail: 'start' };
        await sleep(30);
        yield { type: 'phase', phase: 'slow', detail: 'end' };
      },
    };
    const fast: Phase<Ctx> = {
      name: 'fast',
      async *run() {
        yield { type: 'phase', phase: 'fast', detail: 'start' };
        await sleep(5);
        yield { type: 'phase', phase: 'fast', detail: 'end' };
      },
    };
    const events: PipelineEvent[] = [];
    for await (const ev of parallelPhases('p', [slow, fast]).run(makeCtx())) {
      events.push(ev);
    }
    const fastEnd = events.findIndex(
      (e) => e.type === 'phase' && e.phase === 'fast' && e.detail === 'end',
    );
    const slowEnd = events.findIndex(
      (e) => e.type === 'phase' && e.phase === 'slow' && e.detail === 'end',
    );
    expect(fastEnd).toBeLessThan(slowEnd);
  });

  it('returns immediately when given an empty phase list', async () => {
    const events: PipelineEvent[] = [];
    for await (const ev of parallelPhases('empty', []).run(makeCtx())) {
      events.push(ev);
    }
    expect(events).toEqual([]);
  });

  it('propagates the first sub-phase error', async () => {
    const failing: Phase<Ctx> = {
      name: 'fail',
      async *run() {
        yield { type: 'phase', phase: 'fail' };
        throw new Error('boom');
      },
    };
    const ok: Phase<Ctx> = {
      name: 'ok',
      async *run() {
        yield { type: 'phase', phase: 'ok' };
      },
    };
    const consume = async () => {
      for await (const _ of parallelPhases('p', [failing, ok]).run(makeCtx())) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow('boom');
  });

  it('three branches all write to ctx and all events surface', async () => {
    const make = (label: 'A' | 'B' | 'C', ms: number): Phase<Ctx> => ({
      name: label.toLowerCase(),
      async *run(ctx) {
        await sleep(ms);
        if (label === 'A') ctx.outA = 'A';
        if (label === 'B') ctx.outB = 'B';
        if (label === 'C') ctx.outC = 'C';
        yield { type: 'phase', phase: label.toLowerCase(), detail: 'done' };
      },
    });
    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of parallelPhases('triple', [
      make('A', 15),
      make('B', 5),
      make('C', 25),
    ]).run(ctx)) {
      events.push(ev);
    }
    expect(ctx.outA).toBe('A');
    expect(ctx.outB).toBe('B');
    expect(ctx.outC).toBe('C');
    expect(events).toHaveLength(3);
  });

  it('lets siblings finish even when one sets ctx.stop', async () => {
    const stopper: Phase<Ctx> = {
      name: 'stopper',
      async *run(ctx) {
        await sleep(5);
        ctx.stop = { reason: 'stopper said so' };
        yield { type: 'phase', phase: 'stopper' };
      },
    };
    const longer: Phase<Ctx> = {
      name: 'longer',
      async *run(ctx) {
        await sleep(20);
        ctx.outA = 'finished anyway';
        yield { type: 'phase', phase: 'longer' };
      },
    };
    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of parallelPhases('p', [stopper, longer]).run(ctx)) {
      events.push(ev);
    }
    expect(ctx.stop).toEqual({ reason: 'stopper said so' });
    expect(ctx.outA).toBe('finished anyway');
    expect(events).toHaveLength(2);
  });
});
