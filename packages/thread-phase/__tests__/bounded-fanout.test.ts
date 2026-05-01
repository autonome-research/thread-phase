import { describe, it, expect, vi } from 'vitest';
import {
  boundedFanout,
  streamingBoundedFanout,
  type FanOutResult,
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

describe("boundedFanout — mode: 'collect'", () => {
  it('returns FanOutResult slots in input order, never rejects on runner errors', async () => {
    const out: FanOutResult<number>[] = await boundedFanout({
      items: [1, 2, 3, 4, 5],
      concurrency: 2,
      mode: 'collect',
      runner: async (n) => {
        if (n % 2 === 0) throw new Error(`boom ${n}`);
        return n * 10;
      },
    });
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ ok: true, value: 10 });
    expect(out[1]).toEqual({ ok: false, error: expect.any(Error) });
    expect((out[1] as { ok: false; error: Error }).error.message).toBe('boom 2');
    expect(out[2]).toEqual({ ok: true, value: 30 });
    expect(out[3]).toEqual({ ok: false, error: expect.any(Error) });
    expect(out[4]).toEqual({ ok: true, value: 50 });
  });

  it('drains the rest of the items even after the first failure', async () => {
    let started = 0;
    const out = await boundedFanout({
      items: Array.from({ length: 10 }, (_, i) => i),
      concurrency: 2,
      mode: 'collect',
      runner: async (n) => {
        started++;
        if (n === 0) throw new Error('first item fails');
        return n;
      },
    });
    expect(started).toBe(10); // all items dispatched, despite item 0 failing
    expect(out[0]).toEqual({ ok: false, error: expect.any(Error) });
    for (let i = 1; i < 10; i++) {
      expect(out[i]).toEqual({ ok: true, value: i });
    }
  });

  it("'reject' mode (default) still rejects on runner error", async () => {
    await expect(
      boundedFanout({
        items: [1, 2, 3],
        runner: async (n) => {
          if (n === 2) throw new Error('reject mode kaboom');
          return n;
        },
      }),
    ).rejects.toThrow('reject mode kaboom');
  });

  it('non-Error throws are coerced to Error', async () => {
    const out = await boundedFanout({
      items: [1],
      mode: 'collect',
      runner: async () => {
        throw 'a string, not an Error';
      },
    });
    expect(out[0]).toEqual({ ok: false, error: expect.any(Error) });
    expect((out[0] as { ok: false; error: Error }).error.message).toBe('a string, not an Error');
  });
});

describe('boundedFanout — onItemError telemetry', () => {
  it("fires onItemError per failed item in 'collect' mode", async () => {
    const errors: Array<{ index: number; message: string }> = [];
    await boundedFanout({
      items: [1, 2, 3, 4],
      mode: 'collect',
      runner: async (n) => {
        if (n % 2 === 0) throw new Error(`even ${n}`);
        return n;
      },
      onItemError: (e) => errors.push({ index: e.index, message: e.error.message }),
    });
    expect(errors.map((e) => e.index).sort()).toEqual([1, 3]);
    expect(errors.find((e) => e.index === 1)!.message).toBe('even 2');
  });

  it("fires onItemError before rejecting in 'reject' mode", async () => {
    const onItemError = vi.fn();
    await expect(
      boundedFanout({
        items: [1, 2, 3],
        runner: async (n) => {
          if (n === 2) throw new Error('mid-batch');
          return n;
        },
        onItemError,
      }),
    ).rejects.toThrow('mid-batch');
    expect(onItemError).toHaveBeenCalled();
    const call = onItemError.mock.calls[0]![0];
    expect(call.index).toBe(1);
    expect(call.error.message).toBe('mid-batch');
  });
});

describe('boundedFanout — signal forwarding', () => {
  it('forwards the AbortSignal as the third arg to runner', async () => {
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];
    await boundedFanout({
      items: [1, 2, 3],
      runner: async (_n, _i, signal) => {
        if (signal) seenSignals.push(signal);
        return _n;
      },
      signal: controller.signal,
    });
    expect(seenSignals).toHaveLength(3);
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true);
  });

  it('runner can observe the forwarded signal to abort early', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort('user cancelled'), 10);
    let unwoundEarly = 0;
    const promise = boundedFanout({
      items: Array.from({ length: 8 }, (_, i) => i),
      concurrency: 2,
      runner: async (n, _i, signal) => {
        // Simulate an abortable downstream call: race a timer against the signal.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 50);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            unwoundEarly++;
            reject(new Error('aborted by signal in runner'));
          });
        });
        return n;
      },
      signal: controller.signal,
    });
    await expect(promise).rejects.toThrow();
    // At least one in-flight runner observed the signal and unwound rather
    // than running its full 50ms timer.
    expect(unwoundEarly).toBeGreaterThan(0);
  });
});

describe("streamingBoundedFanout — mode: 'collect'", () => {
  it("yields item_error events instead of throwing in 'collect' mode", async () => {
    const events: StreamingFanoutEvent<number, number>[] = [];
    for await (const e of streamingBoundedFanout({
      items: [1, 2, 3, 4],
      concurrency: 2,
      mode: 'collect',
      runner: async (n) => {
        if (n === 3) throw new Error('three is bad');
        return n * 10;
      },
    })) {
      events.push(e);
    }
    const errors = events.filter((e) => e.type === 'item_error');
    const dones = events.filter((e) => e.type === 'item_done');
    const final = events[events.length - 1]!;
    expect(errors).toHaveLength(1);
    expect(dones).toHaveLength(3);
    expect(final.type).toBe('done_collected');
    if (final.type === 'done_collected') {
      expect(final.results[0]).toEqual({ ok: true, value: 10 });
      expect(final.results[2]).toEqual({ ok: false, error: expect.any(Error) });
    }
  });

  it("preserves throw-on-first-error in default 'reject' mode", async () => {
    const consume = async () => {
      for await (const _ of streamingBoundedFanout({
        items: [1, 2, 3],
        runner: async (n) => {
          if (n === 2) throw new Error('default mode throws');
          return n;
        },
      })) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow('default mode throws');
  });
});
