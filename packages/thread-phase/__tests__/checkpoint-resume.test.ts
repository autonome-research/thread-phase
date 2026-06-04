/**
 * Tests for v4.1.0 checkpoint/resume: Phase.checkpointKey marks phases
 * for skip-on-resume; orchestrator emits phase_complete events after
 * each checkpointed phase finishes cleanly; callers derive the
 * completedKeys set from a prior event log via
 * completedCheckpointsFromEvents.
 */

import { describe, it, expect } from 'vitest';
import {
  runPipeline,
  completedCheckpointsFromEvents,
} from '../src/orchestrator.js';
import { PipelineCache } from '../src/cache.js';
import type { Phase, BasePipelineContext, PipelineEvent } from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  log: string[];
}

const mkCtx = (): Ctx => ({ cache: new PipelineCache(), log: [] });

async function collect(
  gen: AsyncGenerator<PipelineEvent | unknown, void>,
): Promise<PipelineEvent[]> {
  const out: PipelineEvent[] = [];
  for await (const e of gen) out.push(e as PipelineEvent);
  return out;
}

describe('checkpoint emission', () => {
  it('emits phase_complete after each checkpointed phase finishes cleanly', async () => {
    const phases: Phase<Ctx>[] = [
      { name: 'fetch', checkpointKey: 'fetched', async *run(c) { c.log.push('fetch'); } },
      { name: 'process', checkpointKey: 'processed', async *run(c) { c.log.push('process'); } },
    ];
    const events = await collect(runPipeline(phases, mkCtx()));
    const completes = events.filter((e) => e.type === 'phase_complete');
    expect(completes).toHaveLength(2);
    expect(completes[0]).toEqual({
      type: 'phase_complete',
      phase: 'fetch',
      checkpointKey: 'fetched',
    });
    expect(completes[1]).toEqual({
      type: 'phase_complete',
      phase: 'process',
      checkpointKey: 'processed',
    });
  });

  it('does NOT emit phase_complete for phases without a checkpointKey', async () => {
    const phases: Phase<Ctx>[] = [
      { name: 'transient', async *run(c) { c.log.push('transient'); } },
      { name: 'durable', checkpointKey: 'd1', async *run(c) { c.log.push('durable'); } },
    ];
    const events = await collect(runPipeline(phases, mkCtx()));
    const completes = events.filter((e) => e.type === 'phase_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ checkpointKey: 'd1' });
  });

  it('does NOT emit phase_complete for phases that throw', async () => {
    const phases: Phase<Ctx>[] = [
      {
        name: 'crashy',
        checkpointKey: 'never',
        async *run() {
          throw new Error('boom');
        },
      },
    ];
    let threw: unknown = null;
    const events: PipelineEvent[] = [];
    try {
      for await (const e of runPipeline(phases, mkCtx())) {
        events.push(e as PipelineEvent);
      }
    } catch (err) {
      threw = err;
    }
    expect((threw as Error)?.message).toBe('boom');
    expect(events.find((e) => e.type === 'phase_complete')).toBeUndefined();
  });
});

describe('resume skipping', () => {
  it('skips phases whose checkpointKey appears in completedKeys', async () => {
    const log: string[] = [];
    const phases: Phase<Ctx>[] = [
      { name: 'a', checkpointKey: 'a-done', async *run() { log.push('a'); } },
      { name: 'b', checkpointKey: 'b-done', async *run() { log.push('b'); } },
      { name: 'c', async *run() { log.push('c'); } },
    ];
    const completedKeys = new Set(['a-done']);
    await collect(runPipeline(phases, mkCtx(), { resume: { completedKeys } }));
    expect(log).toEqual(['b', 'c']); // 'a' skipped
  });

  it('phases without a checkpointKey ALWAYS run, even on resume', async () => {
    const log: string[] = [];
    const phases: Phase<Ctx>[] = [
      { name: 'transient', async *run() { log.push('transient'); } },
      { name: 'a', checkpointKey: 'a-done', async *run() { log.push('a'); } },
    ];
    await collect(
      runPipeline(phases, mkCtx(), { resume: { completedKeys: new Set(['a-done']) } }),
    );
    expect(log).toEqual(['transient']);
  });

  it('does NOT re-emit phase_complete for skipped phases', async () => {
    const phases: Phase<Ctx>[] = [
      { name: 'a', checkpointKey: 'a-done', async *run() {} },
      { name: 'b', checkpointKey: 'b-done', async *run() {} },
    ];
    const events = await collect(
      runPipeline(phases, mkCtx(), { resume: { completedKeys: new Set(['a-done']) } }),
    );
    const completes = events.filter((e) => e.type === 'phase_complete');
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({ checkpointKey: 'b-done' });
  });

  it('skips all phases when every checkpointKey is in completedKeys (pipeline is a no-op)', async () => {
    let touched = false;
    const phases: Phase<Ctx>[] = [
      { name: 'a', checkpointKey: 'a', async *run() { touched = true; } },
      { name: 'b', checkpointKey: 'b', async *run() { touched = true; } },
    ];
    await collect(
      runPipeline(phases, mkCtx(), {
        resume: { completedKeys: new Set(['a', 'b']) },
      }),
    );
    expect(touched).toBe(false);
  });
});

describe('completedCheckpointsFromEvents helper', () => {
  it('returns the set of checkpointKey values from an event log', () => {
    const events: PipelineEvent[] = [
      { type: 'phase', phase: 'fetch' },
      { type: 'phase_complete', phase: 'fetch', checkpointKey: 'fetched' },
      { type: 'phase', phase: 'process' },
      { type: 'phase_complete', phase: 'process', checkpointKey: 'processed' },
      { type: 'done' },
    ];
    const keys = completedCheckpointsFromEvents(events);
    expect(keys).toEqual(new Set(['fetched', 'processed']));
  });

  it('ignores events of other types', () => {
    const events: PipelineEvent[] = [
      { type: 'content', content: 'hi' },
      { type: 'data', key: 'k', value: 1 },
      { type: 'done' },
    ];
    expect(completedCheckpointsFromEvents(events)).toEqual(new Set());
  });
});

describe('round-trip — original run + resumed run produces expected log', () => {
  it('original run emits phase_complete; resume skips them and only runs the remaining phase', async () => {
    const phases: Phase<Ctx>[] = [
      { name: 'fetch', checkpointKey: 'fetched', async *run(c) { c.log.push('fetch'); } },
      { name: 'process', checkpointKey: 'processed', async *run(c) { c.log.push('process'); } },
      { name: 'publish', async *run(c) { c.log.push('publish'); } },
    ];

    // First run — everything executes.
    const ctx1 = mkCtx();
    const events1 = await collect(runPipeline(phases, ctx1));
    expect(ctx1.log).toEqual(['fetch', 'process', 'publish']);

    // Resume: derive completedKeys from the first run's events.
    const completedKeys = completedCheckpointsFromEvents(events1);
    expect(completedKeys).toEqual(new Set(['fetched', 'processed']));

    const ctx2 = mkCtx();
    await collect(runPipeline(phases, ctx2, { resume: { completedKeys } }));
    expect(ctx2.log).toEqual(['publish']); // 'fetch' + 'process' skipped
  });
});
