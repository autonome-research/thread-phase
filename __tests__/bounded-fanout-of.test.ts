/**
 * boundedFanoutOf — adapter-driven fanout tests.
 *
 * Mirrors bounded-fanout.test.ts conventions. Covers happy path,
 * concurrency cap, event-bus propagation, signal propagation, fail-fast
 * and collect error modes, onItemEnd ordering, and traceId propagation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  boundedFanoutOf,
  BoundedFanoutOfError,
} from '../src/patterns/bounded-fanout-of.js';
import { createEventBus } from '../src/agents/event-bus.js';
import {
  defineAgentAdapter,
  type AgentAdapterMeta,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
} from '../src/agents/protocol.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const emptyUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

interface ScriptedConfig {
  /** ms the adapter "runs" before resolving — used to exercise concurrency. */
  delayMs: number;
  /** Result text + finishReason driver. */
  text?: string;
  finishReason?: AgentRunResult['finishReason'];
  /** Side-effect counters for asserting in-flight cap and start count. */
  hooks?: {
    onStart?: () => void;
    onEnd?: () => void;
  };
}

/**
 * Tiny inline adapter for these tests. It honors options.signal (resolves
 * immediately with finishReason: 'aborted' if aborted at start or during
 * the delay) and mirrors agent_start/agent_end onto options.eventBus.
 *
 * We use a bespoke adapter rather than createMockAgent because we need to
 * (a) drive per-call delay from the buildConfig output, (b) observe
 * traceId received per call, and (c) react to signal mid-delay.
 */
function createScriptedAdapter(opts: {
  id?: string;
  /** Captures the traceId observed on each call, in call order. */
  traceIds?: string[];
} = {}): AgentAdapterMeta<ScriptedConfig> {
  const id = opts.id ?? 'scripted';
  return defineAgentAdapter<ScriptedConfig>({
    id,
    capabilities: {
      streaming: 'text',
      cancellation: 'cooperative',
      resumption: 'none',
      structuredOutput: 'none',
    },
    adapter: (config: ScriptedConfig, options?: AgentRunOptions): AgentRun => {
      const bus = options?.eventBus;
      const externalSignal = options?.signal;
      const localController = new AbortController();
      const composite: AbortSignal = externalSignal
        ? AbortSignal.any([externalSignal, localController.signal])
        : localController.signal;

      if (opts.traceIds) opts.traceIds.push(options?.traceId ?? '<none>');

      let resolveResult!: (v: AgentRunResult) => void;
      const resultPromise = new Promise<AgentRunResult>((r) => (resolveResult = r));

      const events: AgentEvent[] = [];
      let started = false;
      const start = (): void => {
        if (started) return;
        started = true;
        config.hooks?.onStart?.();
        const startEv: AgentEvent = { type: 'agent_start', source: id, traceId: options?.traceId };
        events.push(startEv);
        bus?.emit(startEv);

        const finalize = (reason: AgentRunResult['finishReason']): void => {
          const endEv: AgentEvent = { type: 'agent_end', source: id, traceId: options?.traceId, reason };
          events.push(endEv);
          bus?.emit(endEv);
          config.hooks?.onEnd?.();
          resolveResult({
            text: config.text ?? '',
            finishReason: reason,
            usage: emptyUsage,
            executedToolCalls: [],
          });
        };

        if (composite.aborted) {
          finalize('aborted');
          return;
        }

        const t = setTimeout(() => {
          composite.removeEventListener('abort', onAbort);
          finalize(config.finishReason ?? 'stop');
        }, config.delayMs);
        const onAbort = (): void => {
          clearTimeout(t);
          finalize('aborted');
        };
        composite.addEventListener('abort', onAbort, { once: true });
      };

      const result: Promise<AgentRunResult> = {
        then: (f, r) => {
          start();
          return resultPromise.then(f, r);
        },
        catch: (r) => {
          start();
          return resultPromise.catch(r);
        },
        finally: (f) => {
          start();
          return resultPromise.finally(f);
        },
        [Symbol.toStringTag]: 'Promise',
      } as Promise<AgentRunResult>;

      // events iterable not exercised by boundedFanoutOf; provide a minimal
      // single-shot iterable so the AgentRun shape is complete.
      const eventsIterable: AsyncIterable<AgentEvent> = {
        [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
          start();
          let i = 0;
          return {
            async next(): Promise<IteratorResult<AgentEvent>> {
              await resultPromise;
              if (i < events.length) {
                return { value: events[i++]!, done: false };
              }
              return { value: undefined as unknown as AgentEvent, done: true };
            },
          };
        },
      };

      return {
        events: eventsIterable,
        result,
        abort(_reason?: string): void {
          localController.abort();
        },
      };
    },
  });
}

describe('boundedFanoutOf — happy path', () => {
  it('returns results in input order with one entry per item', async () => {
    const adapter = createScriptedAdapter();
    const out = await boundedFanoutOf({
      items: [10, 5, 20, 1, 15],
      concurrency: 2,
      adapter,
      buildConfig: (n) => ({ delayMs: n, text: `t-${n}` }),
    });
    expect(out).toHaveLength(5);
    expect(out.map((r) => r.text)).toEqual(['t-10', 't-5', 't-20', 't-1', 't-15']);
    expect(out.every((r) => r.finishReason === 'stop')).toBe(true);
  });

  it('handles an empty items array', async () => {
    const adapter = createScriptedAdapter();
    const out = await boundedFanoutOf({
      items: [],
      concurrency: 4,
      adapter,
      buildConfig: () => ({ delayMs: 0 }),
    });
    expect(out).toEqual([]);
  });
});

describe('boundedFanoutOf — concurrency cap', () => {
  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const adapter = createScriptedAdapter();
    await boundedFanoutOf({
      items: Array.from({ length: 20 }, (_, i) => i),
      concurrency: 3,
      adapter,
      buildConfig: () => ({
        delayMs: 10,
        hooks: {
          onStart: () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
          },
          onEnd: () => {
            inFlight--;
          },
        },
      }),
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // confirm parallelism happened
  });

  it('clamps concurrency to items.length when oversubscribed', async () => {
    let inFlight = 0;
    let peak = 0;
    const adapter = createScriptedAdapter();
    await boundedFanoutOf({
      items: [1, 2],
      concurrency: 10,
      adapter,
      buildConfig: () => ({
        delayMs: 5,
        hooks: {
          onStart: () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
          },
          onEnd: () => {
            inFlight--;
          },
        },
      }),
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('boundedFanoutOf — eventBus propagation', () => {
  it('mirrors agent_start events from every per-item run onto the shared bus', async () => {
    const bus = createEventBus();
    const seenStarts: AgentEvent[] = [];
    bus.on((ev) => {
      if (ev.type === 'agent_start') seenStarts.push(ev);
    });

    const adapter = createScriptedAdapter();
    await boundedFanoutOf({
      items: ['a', 'b', 'c'],
      concurrency: 2,
      adapter,
      buildConfig: (s) => ({ delayMs: 5, text: s }),
      eventBus: bus,
    });

    expect(seenStarts).toHaveLength(3);
    expect(seenStarts.every((e) => e.source === 'scripted')).toBe(true);
  });

  it('also mirrors agent_end events from every per-item run', async () => {
    const bus = createEventBus();
    const seen: AgentEvent[] = [];
    bus.on((ev) => seen.push(ev));

    const adapter = createScriptedAdapter();
    await boundedFanoutOf({
      items: [1, 2, 3, 4],
      concurrency: 2,
      adapter,
      buildConfig: () => ({ delayMs: 2 }),
      eventBus: bus,
    });

    const starts = seen.filter((e) => e.type === 'agent_start');
    const ends = seen.filter((e) => e.type === 'agent_end');
    expect(starts).toHaveLength(4);
    expect(ends).toHaveLength(4);
  });
});

describe('boundedFanoutOf — signal propagation', () => {
  it('pre-aborted signal results in all items finishing with aborted', async () => {
    const controller = new AbortController();
    controller.abort('pre-aborted');
    const adapter = createScriptedAdapter();

    const out = await boundedFanoutOf({
      items: [1, 2, 3, 4],
      concurrency: 2,
      adapter,
      buildConfig: () => ({ delayMs: 100, finishReason: 'stop' }),
      signal: controller.signal,
      mode: 'collect',
    });

    expect(out).toHaveLength(4);
    expect(out.every((r) => r.finishReason === 'aborted')).toBe(true);
  });

  it('forwards a composite signal to the adapter so mid-flight abort unwinds it', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort('mid-flight'), 10);
    const adapter = createScriptedAdapter();

    const out = await boundedFanoutOf({
      items: Array.from({ length: 6 }, (_, i) => i),
      concurrency: 2,
      adapter,
      buildConfig: () => ({ delayMs: 100, finishReason: 'stop' }),
      signal: controller.signal,
      mode: 'collect',
    });
    expect(out).toHaveLength(6);
    // At least the in-flight runs at abort time observed the signal and
    // resolved as aborted rather than waiting out the full 100ms delay.
    const aborted = out.filter((r) => r.finishReason === 'aborted').length;
    expect(aborted).toBeGreaterThan(0);
  });
});

describe('boundedFanoutOf — fail-fast mode', () => {
  it('rejects with BoundedFanoutOfError carrying the failing index', async () => {
    const adapter = createScriptedAdapter();
    await expect(
      boundedFanoutOf({
        items: [1, 2, 3],
        concurrency: 1,
        adapter,
        buildConfig: (n) => ({
          delayMs: 2,
          finishReason: n === 2 ? 'error' : 'stop',
          text: `t-${n}`,
        }),
      }),
    ).rejects.toBeInstanceOf(BoundedFanoutOfError);

    // Re-run to inspect the error fields directly.
    let caught: unknown;
    try {
      await boundedFanoutOf({
        items: [1, 2, 3],
        concurrency: 1,
        adapter,
        buildConfig: (n) => ({
          delayMs: 2,
          finishReason: n === 2 ? 'error' : 'stop',
          text: `t-${n}`,
        }),
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BoundedFanoutOfError);
    const err = caught as BoundedFanoutOfError;
    expect(err.itemIndex).toBe(1);
    expect(err.result.finishReason).toBe('error');
  });

  it('cancels remaining items so they never start after the first failure', async () => {
    let started = 0;
    const adapter = createScriptedAdapter();

    // Concurrency 1 so item 0 fails before items 1..9 ever dispatch.
    await expect(
      boundedFanoutOf({
        items: Array.from({ length: 10 }, (_, i) => i),
        concurrency: 1,
        adapter,
        buildConfig: (n) => ({
          delayMs: 2,
          finishReason: n === 0 ? 'error' : 'stop',
          hooks: { onStart: () => started++ },
        }),
      }),
    ).rejects.toBeInstanceOf(BoundedFanoutOfError);

    expect(started).toBeLessThan(10);
  });

  it('fires onItemError exactly once on the failing item', async () => {
    const onItemError = vi.fn();
    const adapter = createScriptedAdapter();
    await expect(
      boundedFanoutOf({
        items: [1, 2, 3],
        concurrency: 1,
        adapter,
        buildConfig: (n) => ({
          delayMs: 2,
          finishReason: n === 2 ? 'error' : 'stop',
        }),
        onItemError,
      }),
    ).rejects.toBeInstanceOf(BoundedFanoutOfError);
    expect(onItemError).toHaveBeenCalledTimes(1);
    expect(onItemError.mock.calls[0]![1]).toBe(1); // index of failing item
  });
});

describe('boundedFanoutOf — collect mode', () => {
  it('returns N results, with the failing one stored as finishReason: error', async () => {
    const adapter = createScriptedAdapter();
    const out = await boundedFanoutOf({
      items: [1, 2, 3, 4, 5],
      concurrency: 2,
      adapter,
      buildConfig: (n) => ({
        delayMs: 2,
        finishReason: n === 3 ? 'error' : 'stop',
        text: `t-${n}`,
      }),
      mode: 'collect',
    });

    expect(out).toHaveLength(5);
    expect(out[0]!.finishReason).toBe('stop');
    expect(out[1]!.finishReason).toBe('stop');
    expect(out[2]!.finishReason).toBe('error');
    expect(out[3]!.finishReason).toBe('stop');
    expect(out[4]!.finishReason).toBe('stop');
  });

  it('drains every item even after a failure', async () => {
    let started = 0;
    const adapter = createScriptedAdapter();
    await boundedFanoutOf({
      items: Array.from({ length: 8 }, (_, i) => i),
      concurrency: 2,
      adapter,
      buildConfig: (n) => ({
        delayMs: 2,
        finishReason: n === 0 ? 'error' : 'stop',
        hooks: { onStart: () => started++ },
      }),
      mode: 'collect',
    });
    expect(started).toBe(8);
  });
});

describe('boundedFanoutOf — onItemEnd hook', () => {
  it('fires once per completed item, in completion order', async () => {
    const completionOrder: number[] = [];
    const adapter = createScriptedAdapter();

    // Stagger delays so completion order is deterministic and NOT input order.
    // Items [25, 5, 15] with concurrency 3 should complete in order 5, 15, 25
    // which is input indices [1, 2, 0].
    await boundedFanoutOf({
      items: [25, 5, 15],
      concurrency: 3,
      adapter,
      buildConfig: (n) => ({ delayMs: n }),
      onItemEnd: (_item, index) => {
        completionOrder.push(index);
      },
    });

    expect(completionOrder).toHaveLength(3);
    expect(completionOrder).toEqual([1, 2, 0]);
  });
});

describe('boundedFanoutOf — traceId propagation', () => {
  it('forwards traceId into every adapter call', async () => {
    const traceIds: string[] = [];
    const adapter = createScriptedAdapter({ traceIds });
    await boundedFanoutOf({
      items: [1, 2, 3, 4],
      concurrency: 2,
      adapter,
      buildConfig: () => ({ delayMs: 1 }),
      traceId: 'trace-xyz',
    });
    expect(traceIds).toHaveLength(4);
    expect(traceIds.every((t) => t === 'trace-xyz')).toBe(true);
  });
});
