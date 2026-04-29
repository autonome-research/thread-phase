import { describe, it, expect, vi } from 'vitest';
import {
  boundedFanout,
  streamingBoundedFanout,
  type StreamingFanoutEvent,
} from '../src/patterns/bounded-fanout.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('boundedFanout', () => {
  it('returns results in input order regardless of completion order', async () => {
    const out = await boundedFanout({
      items: [10, 20, 5, 30, 1],
      concurrency: 3,
      runner: async (n) => {
        await sleep(n);
        return n * 2;
      },
    });
    expect(out).toEqual([20, 40, 10, 60, 2]);
  });

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    await boundedFanout({
      items: Array.from({ length: 20 }, (_, i) => i),
      concurrency: 3,
      runner: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(10);
        inFlight--;
        return null;
      },
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // confirm parallelism happened
  });

  it('fires onItemDone exactly once per item', async () => {
    const seen = vi.fn();
    await boundedFanout({
      items: ['a', 'b', 'c', 'd'],
      concurrency: 2,
      runner: async (s) => s.toUpperCase(),
      onItemDone: seen,
    });
    expect(seen).toHaveBeenCalledTimes(4);
    const indices = seen.mock.calls.map((c) => (c[0] as { index: number }).index).sort();
    expect(indices).toEqual([0, 1, 2, 3]);
  });

  it('respects maxItems cap', async () => {
    const out = await boundedFanout({
      items: [1, 2, 3, 4, 5],
      maxItems: 2,
      concurrency: 4,
      runner: async (n) => n * 10,
    });
    expect(out).toEqual([10, 20]);
  });

  it('handles empty items list', async () => {
    expect(await boundedFanout({ items: [], runner: async () => 1 })).toEqual([]);
  });

  it('clamps concurrency to items.length when oversubscribed', async () => {
    let inFlight = 0;
    let peak = 0;
    await boundedFanout({
      items: [1, 2],
      concurrency: 10,
      runner: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
        return null;
      },
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('propagates the first runner error (Promise.all semantics)', async () => {
    await expect(
      boundedFanout({
        items: [1, 2, 3],
        concurrency: 2,
        runner: async (n) => {
          if (n === 2) throw new Error('boom');
          return n;
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('default concurrency is 4', async () => {
    let inFlight = 0;
    let peak = 0;
    await boundedFanout({
      items: Array.from({ length: 12 }, (_, i) => i),
      runner: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(10);
        inFlight--;
        return null;
      },
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('rejects with abort reason when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('test-abort');
    await expect(
      boundedFanout({
        items: [1, 2, 3],
        runner: async (n) => n,
        signal: controller.signal,
      }),
    ).rejects.toThrow('test-abort');
  });

  it('stops dispatching new items after abort mid-flight', async () => {
    const controller = new AbortController();
    let started = 0;
    const promise = boundedFanout({
      items: Array.from({ length: 20 }, (_, i) => i),
      concurrency: 2,
      runner: async (n) => {
        started++;
        await sleep(10);
        return n;
      },
      signal: controller.signal,
    });
    // Abort after the first batch has started.
    setTimeout(() => controller.abort('cancelled'), 15);
    await expect(promise).rejects.toThrow();
    // We expect strictly fewer items started than total — not all 20.
    expect(started).toBeLessThan(20);
  });
});

describe('streamingBoundedFanout', () => {
  it('yields one item_done event per item plus a final done event', async () => {
    const events: StreamingFanoutEvent<number, number>[] = [];
    for await (const e of streamingBoundedFanout({
      items: [1, 2, 3, 4],
      concurrency: 2,
      runner: async (n) => n * 10,
    })) {
      events.push(e);
    }
    const itemEvents = events.filter((e) => e.type === 'item_done');
    expect(itemEvents).toHaveLength(4);
    const last = events[events.length - 1]!;
    expect(last.type).toBe('done');
    if (last.type === 'done') expect(last.results).toEqual([10, 20, 30, 40]);
  });

  it('reports progress monotonically increasing', async () => {
    const progresses: number[] = [];
    for await (const e of streamingBoundedFanout({
      items: [1, 2, 3, 4, 5],
      concurrency: 2,
      runner: async (n) => {
        await sleep(n);
        return n;
      },
    })) {
      if (e.type === 'item_done') progresses.push(e.progress);
    }
    expect(progresses).toHaveLength(5);
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]!).toBeGreaterThan(progresses[i - 1]!);
    }
    expect(progresses[progresses.length - 1]!).toBeCloseTo(1.0);
  });

  it('preserves input order in the final results array', async () => {
    let final: number[] = [];
    for await (const e of streamingBoundedFanout({
      items: [50, 5, 30, 1],
      concurrency: 4,
      runner: async (n) => {
        await sleep(n);
        return n;
      },
    })) {
      if (e.type === 'done') final = e.results;
    }
    expect(final).toEqual([50, 5, 30, 1]);
  });

  it('throws on first runner error', async () => {
    const consume = async () => {
      for await (const _ of streamingBoundedFanout({
        items: [1, 2, 3],
        concurrency: 1,
        runner: async (n) => {
          if (n === 2) throw new Error('boom');
          return n;
        },
      })) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow('boom');
  });

  it('respects abort signal mid-stream', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort('cancelled'), 15);
    const consume = async () => {
      for await (const _ of streamingBoundedFanout({
        items: Array.from({ length: 30 }, (_, i) => i),
        concurrency: 2,
        runner: async (n) => {
          await sleep(10);
          return n;
        },
        signal: controller.signal,
      })) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow();
  });
});
