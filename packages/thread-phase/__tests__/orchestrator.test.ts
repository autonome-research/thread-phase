import { describe, it, expect } from 'vitest';
import { runPipeline } from '../src/orchestrator.js';
import { PipelineCache } from '../src/cache.js';
import type { Phase, BasePipelineContext, PipelineEvent } from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  visited?: string[];
  failHere?: string;
}

const visit =
  (name: string): Phase<Ctx> => ({
    name,
    async *run(ctx) {
      ctx.visited = [...(ctx.visited ?? []), name];
      yield { type: 'phase', phase: name };
      if (ctx.failHere === name) {
        throw new Error(`fail in ${name}`);
      }
    },
  });

const stop =
  (name: string, reason: string): Phase<Ctx> => ({
    name,
    async *run(ctx) {
      ctx.visited = [...(ctx.visited ?? []), name];
      ctx.stop = { reason };
    },
  });

async function collect(gen: AsyncGenerator<PipelineEvent>): Promise<PipelineEvent[]> {
  const out: PipelineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('runPipeline', () => {
  it('runs phases in order, ends with done', async () => {
    const ctx: Ctx = { cache: new PipelineCache() };
    const events = await collect(runPipeline([visit('a'), visit('b'), visit('c')], ctx));
    expect(ctx.visited).toEqual(['a', 'b', 'c']);
    expect(events.at(-1)).toEqual({ type: 'done' });
    // 3 phase events + 1 done
    expect(events).toHaveLength(4);
  });

  it('halts after a phase sets ctx.stop and emits done with reason', async () => {
    const ctx: Ctx = { cache: new PipelineCache() };
    const events = await collect(
      runPipeline([visit('a'), stop('b', 'short-circuit'), visit('c')], ctx),
    );
    expect(ctx.visited).toEqual(['a', 'b']); // c never runs
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'short-circuit' });
  });

  it('catches phase errors and emits an error event (does not throw)', async () => {
    const ctx: Ctx = { cache: new PipelineCache(), failHere: 'b' };
    const events = await collect(runPipeline([visit('a'), visit('b'), visit('c')], ctx));
    const last = events.at(-1);
    expect(last?.type).toBe('error');
    if (last?.type === 'error') {
      expect(last.message).toMatch(/fail in b/);
    }
    expect(ctx.visited).toEqual(['a', 'b']);
  });

  it('clears the pipeline cache in the finally block', async () => {
    const ctx: Ctx = { cache: new PipelineCache() };
    ctx.cache.set('x', 1);
    await collect(runPipeline([visit('a')], ctx));
    expect(ctx.cache.size).toBe(0);
  });

  it('accepts a readonly array of phases (composition stays type-correct)', async () => {
    const phases: ReadonlyArray<Phase<Ctx>> = [visit('only')];
    const ctx: Ctx = { cache: new PipelineCache() };
    await collect(runPipeline(phases, ctx));
    expect(ctx.visited).toEqual(['only']);
  });
});
