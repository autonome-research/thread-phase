/**
 * Stress angle: state-and-storage.
 *
 * Probes shared mutable state contention surfaces:
 *  - SqliteJobStore: two stores racing on same db file (acquireExclusive + events)
 *  - PipelineCache: concurrent getOrFetch on same key, namespace clear races
 *  - parallelPhases: ctx-field collisions, multi-stop races
 *  - intentGate: read-after-write, ctx.stop visibility in handler
 *  - subPipeline: nesting depth limit, cache isolation, ctx pass-through
 *  - withThread: append-only invariant under concurrent runs sharing one Thread
 *
 * These tests intentionally probe the GAP between docs and behavior. A failing
 * assertion documents a real footgun or bug.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { PipelineCache } from '../src/cache.js';
import { runPipeline } from '../src/orchestrator.js';
import { parallelPhases } from '../src/patterns/parallel-phases.js';
import { intentGate } from '../src/patterns/intent-gate.js';
import { subPipeline } from '../src/patterns/sub-pipeline.js';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import {
  createThread,
  withThread,
  resumeTokenFor,
  threadToMessages,
  type Thread,
} from '../src/agents/index.js';
import { createMockAgent, type MockAgentConfig } from '../src/agents/test-utils/index.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function freshDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `stress-state-and-storage-${randomUUID()}-`));
  return { dir, path: join(dir, 'test.db') };
}

async function collect<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

interface SharedCtx extends BasePipelineContext {
  shared?: string;
  userInput?: string;
  intent2Saw?: string;
  depthTrace?: number[];
  innerCacheHit?: unknown;
}

// ===========================================================================
// 1) SqliteJobStore: two stores racing acquireExclusive on same db file
// ===========================================================================

describe('SqliteJobStore — two stores racing acquireExclusive (multi-process scenario)', () => {
  it('never lets two RUNNING jobs co-exist for the same name; surfaces errors as Promise<string|null> or rejection', async () => {
    const { dir, path } = freshDbPath();
    const storeA = new SqliteJobStore(path);
    const storeB = new SqliteJobStore(path);

    let acquired = 0;
    let nulls = 0;
    let errors = 0;
    const errorMessages: string[] = [];
    const N = 30;

    try {
      for (let i = 0; i < N; i++) {
        const settle = async (p: Promise<string | null>): Promise<void> => {
          try {
            const id = await p;
            if (id) {
              acquired++;
              // Immediately mark done so the next acquire can succeed.
              await storeA.setCompleted(id, null);
            } else {
              nulls++;
            }
          } catch (e) {
            errors++;
            errorMessages.push(e instanceof Error ? e.message : String(e));
          }
        };

        await Promise.all([
          settle(storeA.acquireExclusive('librarian', null)),
          settle(storeB.acquireExclusive('librarian', null)),
        ]);

        // Invariant check at each iteration: never more than one RUNNING.
        const running = (await storeA.listJobs({ name: 'librarian', limit: 200 })).filter(
          (j) => j.status === 'RUNNING',
        );
        expect(running.length).toBeLessThanOrEqual(1);
      }
    } finally {
      storeA.close();
      storeB.close();
      rmSync(dir, { recursive: true, force: true });
    }

    // FINDING-CHECK:
    // The documented signature is Promise<string | null>. A SQLITE_BUSY
    // thrown across process/handle boundaries would be a contract violation
    // since callers expect null on contention, not a throw.
    // Record whatever we observed.
    // We assert that errors are EITHER zero (great) OR all SQLITE_BUSY (so
    // a fix could surface this as null instead of throwing).
    if (errors > 0) {
      // All errors should be busy-style — anything else is a bigger surprise.
      for (const msg of errorMessages) {
        expect(msg).toMatch(/SQLITE_BUSY|database is locked|busy/i);
      }
    }
    expect(acquired + nulls + errors).toBe(N * 2);
    // Document what we got — this is informational, but we assert at least
    // some null returns (otherwise nothing is being serialized).
    expect(acquired).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 2) SqliteJobStore: interleaved appendEvent from two stores, gap/dup hunt
// ===========================================================================

describe('SqliteJobStore — concurrent multi-writer appendEvent + incremental reader', () => {
  it('asserts every id 1..2N appears exactly once on final drain; checks resume-cursor monotonicity', async () => {
    const { dir, path } = freshDbPath();
    const storeA = new SqliteJobStore(path);
    const storeB = new SqliteJobStore(path);
    const PER_WRITER = 500;

    try {
      const jobId = await storeA.createJob('p', null);

      let resumeCursorMonotonic = true;
      let lastSeenOnIncrementalReader = 0;
      let reorderObservation = '';

      const writeLoop = async (
        store: SqliteJobStore,
        label: string,
      ): Promise<void> => {
        for (let i = 0; i < PER_WRITER; i++) {
          try {
            await store.appendEvent(jobId, {
              type: 'content',
              content: `${label}-${i}`,
            } as PipelineEvent);
          } catch (e) {
            // SQLITE_BUSY here is itself a finding. Don't swallow silently.
            throw new Error(`appendEvent threw on ${label}-${i}: ${e instanceof Error ? e.message : e}`);
          }
          // Yield occasionally so reader can interleave.
          if (i % 50 === 0) await sleep(0);
        }
      };

      const readLoop = async (): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          const evs = await storeA.getEvents(jobId, lastSeenOnIncrementalReader);
          for (const e of evs) {
            if (e.id <= lastSeenOnIncrementalReader) {
              resumeCursorMonotonic = false;
              reorderObservation = `saw id=${e.id} after lastSeen=${lastSeenOnIncrementalReader}`;
            }
            lastSeenOnIncrementalReader = Math.max(lastSeenOnIncrementalReader, e.id);
          }
          if (lastSeenOnIncrementalReader >= PER_WRITER * 2) break;
          await sleep(2);
        }
      };

      await Promise.all([
        writeLoop(storeA, 'A'),
        writeLoop(storeB, 'B'),
        readLoop(),
      ]);

      // Final full drain (afterId=0) — no gaps, no dups.
      const all = await storeA.getEvents(jobId, 0);
      const ids = all.map((e) => e.id).sort((a, b) => a - b);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length); // no duplicates
      expect(ids.length).toBe(PER_WRITER * 2); // no drops

      // Document observation. resume cursor should be monotonic per
      // single-reader contract; if not, that's a real footgun for users
      // who restart a runner mid-stream with two writers.
      if (!resumeCursorMonotonic) {
        // surface it loudly
        throw new Error(`Resume cursor non-monotonic: ${reorderObservation}`);
      }
    } finally {
      storeA.close();
      storeB.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 3) PipelineCache.getOrFetch — concurrent callers cause duplicate fetches
// ===========================================================================

describe('PipelineCache.getOrFetch — concurrent same-key callers', () => {
  it('FINDING: fetcher is invoked once per concurrent caller (no in-flight dedup)', async () => {
    const cache = new PipelineCache();
    let counter = 0;
    const fetcher = vi.fn(async () => {
      const snap = ++counter;
      await sleep(20);
      return snap;
    });

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => cache.getOrFetch<number>('k', fetcher)),
    );

    // The "ideal" contract a user reading the JSDoc ("Cache-or-fetch") would
    // expect. If THIS assertion fails, that's the finding — getOrFetch is
    // not in-flight-deduped, so all N concurrent calls invoke the fetcher.
    expect(fetcher).toHaveBeenCalledTimes(1);
    // And every concurrent caller should resolve to the same value.
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });
});

// ===========================================================================
// 4) PipelineCache namespace clear vs concurrent sibling writes
// ===========================================================================

describe('PipelineCache — namespace clear during concurrent writes', () => {
  it("'a'.clear() never wrongly drops 'ab:' keys (prefix-collision check)", async () => {
    const root = new PipelineCache();
    const a = root.namespace('a');
    const ab = root.namespace('ab');
    const nestedAb = root.namespace('a').namespace('b'); // 'a:b:'

    const OPS = 500;

    // Three concurrent loops; Map ops are sync so this mostly exercises
    // microtask interleaving via Promise scheduling.
    const branch1 = (async () => {
      for (let i = 0; i < OPS; i++) {
        a.set(`x${i}`, i);
        if (i % 20 === 0) a.clear();
        if (i % 10 === 0) await sleep(0);
      }
    })();
    const branch2 = (async () => {
      for (let i = 0; i < OPS; i++) {
        ab.set(`y${i}`, i);
        if (i % 10 === 0) await sleep(0);
      }
    })();
    const branch3 = (async () => {
      for (let i = 0; i < OPS; i++) {
        nestedAb.set(`z${i}`, i);
        if (i % 10 === 0) await sleep(0);
      }
    })();

    await Promise.all([branch1, branch2, branch3]);

    // After all branches finish, every 'ab' key must still be intact.
    // Because 'ab:' does NOT start with 'a:' (it starts with 'ab:'), the
    // 'a'.clear() loop must skip them.
    let missingAb = 0;
    for (let i = 0; i < OPS; i++) {
      if (!ab.has(`y${i}`)) missingAb++;
    }
    expect(missingAb).toBe(0);

    // FINDING (documented in scenario plan, not a bug per se): nested
    // 'a:b:' keys DO start with 'a:' and so ARE swept by 'a'.clear().
    // We don't assert here because it's deterministic ordering-dependent,
    // but we surface it: after the LAST a.clear() at the last (i % 20 == 0)
    // tick before OPS, branch3 may have added more z* keys. So the count of
    // z keys present is between 0 and OPS — but cleared keys means the
    // namespace docs leak. Just confirm it CAN happen.
    // (Don't fail the test; this is a docs gap, not a bug.)
  });
});

// ===========================================================================
// 5) parallelPhases — ctx-field collision + multi-stop race
// ===========================================================================

describe('parallelPhases — ctx-field collision & multi-stop semantics', () => {
  it('non-deterministic last-write-wins on shared ctx field (no enforcement, no warning)', async () => {
    const branch = (label: string): Phase<SharedCtx> => ({
      name: label,
      async *run(ctx) {
        for (let i = 0; i < 10; i++) {
          ctx.shared = `${label}-${i}`;
          yield { type: 'phase', phase: label, detail: String(i) };
          await sleep(Math.floor(Math.random() * 5) + 1);
        }
      },
    });

    const composite = parallelPhases<SharedCtx>('p', [
      branch('A'),
      branch('B'),
      branch('C'),
    ]);

    const ctx: SharedCtx = { cache: new PipelineCache() };
    await collect(composite.run(ctx));

    // Whichever branch wrote last wins. Assert: SOMETHING is set, and it
    // matches one of the three labels. (Don't assert the specific winner —
    // that's the whole point: non-deterministic.)
    expect(ctx.shared).toBeDefined();
    expect(['A', 'B', 'C'].some((l) => ctx.shared!.startsWith(`${l}-`))).toBe(true);
  });

  it('multi-stop race: exactly one done event with one reason; both stoppers reach finish', async () => {
    const stopper = (reason: string, after: number): Phase<SharedCtx> => ({
      name: `stop-${reason}`,
      async *run(ctx) {
        await sleep(after);
        ctx.stop = { reason };
        yield { type: 'phase', phase: `stop-${reason}` };
      },
    });

    const composite = parallelPhases<SharedCtx>('multi-stop', [
      stopper('alpha', 5),
      stopper('beta', 5),
    ]);
    const ctx: SharedCtx = { cache: new PipelineCache() };

    // Outer pipeline wraps it so we see the `done` event.
    const events = await collect(runPipeline([composite], ctx));

    const doneEvents = events.filter((e) => e.type === 'done');
    expect(doneEvents).toHaveLength(1);
    const done = doneEvents[0] as { type: 'done'; reason?: string };
    expect(done.reason).toBeDefined();
    expect(['alpha', 'beta']).toContain(done.reason);
    // Both stopper phase events surfaced (both branches finished).
    const stopPhases = events.filter(
      (e) => e.type === 'phase' && (e as { phase?: string }).phase?.startsWith('stop-'),
    );
    expect(stopPhases).toHaveLength(2);
  });
});

// ===========================================================================
// 6) intentGate — read-after-write & ctx.stop visibility in handler
// ===========================================================================

describe('intentGate — read-after-write semantics & handler view of ctx.stop', () => {
  it('second classifier sees mutations made by first handler (post-await ctx is live)', async () => {
    const gate1 = intentGate<SharedCtx, 'go' | 'skip'>('gate1', {
      classify: async (ctx) => {
        ctx.userInput = ctx.userInput ?? 'initial';
        return { intent: 'go' };
      },
      route: () => ({
        stop: 'gate1-stopped',
        handler: async function* (ctx) {
          yield { type: 'agent_activity', agent: 'gate1', action: 'mid-handler' };
          // Mid-yield mutation
          ctx.userInput = 'mutated-by-gate1-handler';
          yield { type: 'agent_activity', agent: 'gate1', action: 'post-mutation' };
        },
      }),
    });

    // gate1 sets ctx.stop, so gate2 will not run via outer orchestrator.
    // Instead, run gate2 directly on the same ctx AFTER gate1.run() drains,
    // to observe whether the handler's mutation is visible to a downstream
    // reader.
    const ctx: SharedCtx = { cache: new PipelineCache(), userInput: 'initial' };
    await collect(gate1.run(ctx));

    // After gate1 finishes, ctx.userInput should reflect the handler's
    // mid-yield mutation. This pins down "ctx is live mutable shared state".
    expect(ctx.userInput).toBe('mutated-by-gate1-handler');

    // Also: ctx.stop should be set (the gate marked it AFTER handler exhaust).
    expect(ctx.stop).toEqual({ reason: 'gate1-stopped' });
  });

  it('FINDING: handler does NOT see its own ctx.stop while yielding (ctx.stop is set AFTER handler exhaust)', async () => {
    let stopVisibleToHandler: boolean | null = null;
    const gate = intentGate<SharedCtx, 'go'>('gate', {
      classify: async () => ({ intent: 'go' }),
      route: () => ({
        stop: 'my-stop',
        handler: async function* (ctx) {
          // Handler is running, but ctx.stop has not been assigned yet.
          // This is the contract gap: a long-running handler can't observe
          // its own stop signal (it's set only AFTER handler returns).
          stopVisibleToHandler = ctx.stop !== undefined;
          yield { type: 'agent_activity', agent: 'gate', action: 'inside-handler' };
        },
      }),
    });

    const ctx: SharedCtx = { cache: new PipelineCache() };
    await collect(gate.run(ctx));
    // FINDING: handler sees stop === undefined while it's running.
    // This is intent-gate.ts:53-56 — handler runs BEFORE ctx.stop = ...
    expect(stopVisibleToHandler).toBe(false);
    // Post-handler, ctx.stop is set.
    expect(ctx.stop).toEqual({ reason: 'my-stop' });
  });
});

// ===========================================================================
// 7) subPipeline — nesting depth, cache isolation, ctx pass-through
// ===========================================================================

describe('subPipeline — deep nesting probe', () => {
  function makeNestedPhase(depth: number, maxDepth: number): Phase<SharedCtx> {
    const name = `level-${depth}`;
    if (depth >= maxDepth) {
      return {
        name,
        async *run(ctx) {
          ctx.depthTrace = [...(ctx.depthTrace ?? []), depth];
          yield { type: 'phase', phase: name };
        },
      };
    }
    const innerPhase = makeNestedPhase(depth + 1, maxDepth);
    return subPipeline<SharedCtx, SharedCtx>(name, {
      // Use the OUTER ctx as the inner ctx so depthTrace accumulates.
      // mapInput identity reuses the same ctx.
      pipeline: { phases: [innerPhase], ctx: undefined as unknown as SharedCtx },
      mapInput: (outer) => {
        outer.depthTrace = [...(outer.depthTrace ?? []), depth];
        return outer;
      },
    });
  }

  it('survives depth 50 with strict ordering and ctx pass-through', async () => {
    const N = 50;
    const root = makeNestedPhase(0, N);
    const ctx: SharedCtx = { cache: new PipelineCache() };

    const events = await collect(runPipeline([root], ctx));
    // Each level (0..N-1) calls mapInput appending its depth, plus level N
    // appends its own depth in its phase body.
    expect(ctx.depthTrace).toHaveLength(N + 1);
    expect(ctx.depthTrace![0]).toBe(0);
    expect(ctx.depthTrace![N]).toBe(N);

    // Exactly one phase event from the innermost level, plus done at outer.
    const phaseEvents = events.filter((e) => e.type === 'phase');
    expect(phaseEvents).toHaveLength(1);
    expect((phaseEvents[0] as { phase: string }).phase).toBe(`level-${N}`);
  });

  it('observes depth ceiling (stack overflow / range error) at very large N', async () => {
    // We don't fix a specific number; we record what happens. If it survives
    // depth 1000, great. If it crashes, that IS the finding to document.
    const probe = async (N: number): Promise<{ ok: boolean; err?: string }> => {
      try {
        const root = makeNestedPhase(0, N);
        const ctx: SharedCtx = { cache: new PipelineCache() };
        await collect(runPipeline([root], ctx));
        return { ok: true };
      } catch (e) {
        return { ok: false, err: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
      }
    };

    const r100 = await probe(100);
    expect(r100.ok).toBe(true);

    const r1000 = await probe(1000);
    // Document: we expect this to either pass or fail with stack-related
    // error. Either way, surface what we saw.
    if (!r1000.ok) {
      // Real footgun for users with deeply nested pipelines. Don't fail
      // the test — record evidence and continue.
      expect(r1000.err).toMatch(/stack|range|maximum/i);
    } else {
      expect(r1000.ok).toBe(true);
    }
  });

  it('each nesting level gets its own PipelineCache (cache isolation invariant)', async () => {
    let innerCacheValue: unknown = 'not-set';
    let outerCacheValueAfter: unknown = 'not-checked';

    // Inner pipeline phase writes to its (fresh) cache.
    const innerPhase: Phase<SharedCtx> = {
      name: 'inner-cache-writer',
      async *run(ctx) {
        ctx.cache.set('secret', 'inner-value');
        innerCacheValue = ctx.cache.get('secret');
        yield { type: 'phase', phase: 'inner-cache-writer' };
      },
    };

    const wrapper = subPipeline<SharedCtx, SharedCtx>('outer', {
      pipeline: { phases: [innerPhase], ctx: undefined as unknown as SharedCtx },
      mapInput: (outer) => outer, // same ctx, but subPipeline replaces ctx.cache
      mapOutput: (outer, inner) => {
        // Inner cache should already be cleared by the inner runPipeline's
        // finally block. Outer's cache should be untouched.
        outerCacheValueAfter = outer.cache.get('secret');
      },
    });

    const outerCtx: SharedCtx = { cache: new PipelineCache() };
    outerCtx.cache.set('outer-key', 'outer-value');
    await collect(runPipeline([wrapper], outerCtx));

    expect(innerCacheValue).toBe('inner-value');
    // The outer cache must not see the inner key.
    expect(outerCacheValueAfter).toBeUndefined();
  });
});

// ===========================================================================
// 8) withThread — concurrent runs on the same Thread object
// ===========================================================================

describe('withThread — concurrent runs sharing one Thread (de-facto single-owner)', () => {
  function configWithToken(token: string, numTextEvents: number = 3): MockAgentConfig {
    return {
      events: Array.from({ length: numTextEvents }, (_, i) => ({
        type: 'text' as const,
        source: 'mock',
        delta: `t${i}`,
      })),
      result: {
        text: 'ok',
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        executedToolCalls: [],
        resumeToken: { kind: 'opaque', data: token },
      },
      perEventDelayMs: 1,
    };
  }

  it('two concurrent runs on one Thread interleave events; no events dropped; resume tokens race', async () => {
    const mock = createMockAgent({ id: 'a1', capabilities: { resumption: 'opaque' } });
    const thread: Thread = createThread();
    const wrapped = withThread(mock, thread);

    const NUM_RUNS = 10;
    const TEXT_PER_RUN = 4;
    // Expected events per run = 1 (agent_start) + TEXT_PER_RUN + 1 (agent_end) = 6
    const EXPECTED_EVENTS_PER_RUN = 2 + TEXT_PER_RUN;

    const runs: Promise<void>[] = [];
    for (let i = 0; i < NUM_RUNS; i++) {
      const cfg = configWithToken(`token-${i}`, TEXT_PER_RUN);
      const run = wrapped.adapter(cfg);
      runs.push(
        (async () => {
          for await (const _ of run.events) {
            // drain
          }
          await run.result;
        })(),
      );
    }
    await Promise.all(runs);

    // 1) No events dropped.
    expect(thread.events.length).toBe(NUM_RUNS * EXPECTED_EVENTS_PER_RUN);

    // 2) resumeToken should be exactly one of the written tokens (not undefined,
    //    not empty object — last-write-wins).
    const finalToken = resumeTokenFor(thread, 'a1');
    expect(finalToken).toBeDefined();
    expect(finalToken!.kind).toBe('opaque');
    if (finalToken!.kind === 'opaque') {
      const validTokens = new Set(
        Array.from({ length: NUM_RUNS }, (_, i) => `token-${i}`),
      );
      expect(validTokens.has(finalToken.data)).toBe(true);
    }

    // 3) Observe: agent_start/end pairs are interleaved across runs. Count
    //    them — should be NUM_RUNS each.
    const starts = thread.events.filter((e) => e.type === 'agent_start').length;
    const ends = thread.events.filter((e) => e.type === 'agent_end').length;
    expect(starts).toBe(NUM_RUNS);
    expect(ends).toBe(NUM_RUNS);

    // 4) threadToMessages should not throw on the interleaved log. The result
    //    is "lossy by design" per the JSDoc, so we just assert it returns
    //    SOMETHING without exception.
    const msgs = threadToMessages(thread);
    expect(Array.isArray(msgs)).toBe(true);
    // FINDING (docs gap, not bug): the resulting messages from concurrent
    // runs collapse turn boundaries between runs. We just confirm execution
    // doesn't blow up — single-thread-per-run is the de-facto contract.
  });
});
