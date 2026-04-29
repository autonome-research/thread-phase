import { describe, it, expect, vi } from 'vitest';
import { boundedFanout } from '../src/patterns/bounded-fanout.js';

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
});
