/**
 * Parameterized vitest suite that asserts an `AgentAdapter` honors the
 * protocol's lifecycle invariants. Both in-tree tests and the sibling
 * `thread-phase-agents` package import this and call it from a `describe`
 * or top-level test file.
 *
 * Invariants asserted (see `protocol.ts` for the canonical statements):
 *   - exactly one `agent_start` at the head of the stream,
 *   - exactly one `agent_end` at the tail of the stream,
 *   - `result` resolves and never rejects,
 *   - `result.finishReason` matches `agent_end.reason`,
 *   - `abort()` is idempotent and yields `finishReason: 'aborted'`,
 *   - `options.signal` is observed,
 *   - `options.eventBus` mirrors the full event stream,
 *   - every event carries `source === meta.id`,
 *   - the `events` AsyncIterable terminates,
 *   - `events` is single-consumer (second iteration attempt throws),
 *   - `events` iterator `return()` cleanly closes the stream,
 *   - `result` resolves even when `events` is never iterated.
 *
 * Adapters that can synthesize internal-error runs supply `buildErrorConfig`
 * to additionally assert the resolve-not-reject invariant on the error path.
 *
 * @internal
 */

import { describe, it, expect } from 'vitest';
import type {
  AgentAdapterMeta,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../protocol.js';
import { createEventBus } from '../event-bus.js';

/**
 * Per-adapter config-builder. Each invocation must return a fresh config
 * suitable for one run. Caller controls how prompts/messages are shaped.
 *
 * @internal
 */
export type ConformanceConfigBuilder<TConfig> = () => TConfig;

/**
 * Options for running the conformance suite against an adapter.
 *
 * @internal
 */
export interface RunConformanceSuiteOptions<TConfig> {
  meta: AgentAdapterMeta<TConfig>;
  buildConfig: ConformanceConfigBuilder<TConfig>;
  /**
   * Optional: build a config that should produce a runner-internal error.
   * Used to test the "result resolves rather than rejects on error" invariant.
   * If omitted, that test is skipped. Sibling adapters that can't reliably
   * trigger an internal error may omit this safely.
   */
  buildErrorConfig?: ConformanceConfigBuilder<TConfig>;
  /** Per-test timeout in ms. Default 10_000. */
  timeoutMs?: number;
}

/**
 * Run the full conformance suite against an adapter. Registers its own
 * `describe` block.
 *
 * @internal
 */
export function runAdapterConformance<TConfig>(
  opts: RunConformanceSuiteOptions<TConfig>,
): void {
  const { meta, buildConfig, buildErrorConfig } = opts;
  const timeout = opts.timeoutMs ?? 10_000;

  describe(`AgentAdapter conformance: ${meta.id}`, () => {
    it(
      'emits agent_start as the first event with source === meta.id',
      async () => {
        const run = meta.adapter(buildConfig());
        const events = await collectEvents(run);
        expect(events.length).toBeGreaterThan(0);
        expect(events[0]!.type).toBe('agent_start');
        expect(events[0]!.source).toBe(meta.id);
        await run.result;
      },
      timeout,
    );

    it(
      'emits exactly one agent_end and it is the last event',
      async () => {
        const run = meta.adapter(buildConfig());
        const events = await collectEvents(run);
        const ends = events.filter((e) => e.type === 'agent_end');
        expect(ends).toHaveLength(1);
        expect(events[events.length - 1]!.type).toBe('agent_end');
        await run.result;
      },
      timeout,
    );

    it(
      'result resolves and never rejects',
      async () => {
        const run = meta.adapter(buildConfig());
        // Drain events in parallel so result can settle.
        const [, result] = await Promise.all([collectEvents(run), run.result]);
        expect(result).toBeDefined();
        // Sanity: finishReason is one of the known values.
        expect(typeof result.finishReason).toBe('string');
      },
      timeout,
    );

    it(
      'result.finishReason matches agent_end.reason',
      async () => {
        const run = meta.adapter(buildConfig());
        const [events, result] = await Promise.all([collectEvents(run), run.result]);
        const end = events.find((e) => e.type === 'agent_end');
        expect(end).toBeDefined();
        if (end && end.type === 'agent_end') {
          expect(end.reason).toBe(result.finishReason);
        }
      },
      timeout,
    );

    it(
      'abort() is idempotent and produces finishReason: "aborted"',
      async () => {
        const run = meta.adapter(buildConfig());
        // Abort synchronously so adapters of any speed observe it before
        // they finish. Real consumers that abort mid-run hit a slower path;
        // the invariant we care about here is "abort wins, twice is fine".
        run.abort();
        run.abort(); // second call must not throw
        const [, result] = await Promise.all([collectEvents(run), run.result]);
        expect(result.finishReason).toBe('aborted');
      },
      timeout,
    );

    it(
      'honors AbortSignal from options',
      async () => {
        const controller = new AbortController();
        controller.abort();
        const options: AgentRunOptions = { signal: controller.signal };
        const run = meta.adapter(buildConfig(), options);
        const [, result] = await Promise.all([collectEvents(run), run.result]);
        expect(result.finishReason).toBe('aborted');
      },
      timeout,
    );

    it(
      'mirrors every event to options.eventBus',
      async () => {
        const bus = createEventBus();
        const seen: AgentEvent[] = [];
        bus.on((event) => {
          seen.push(event);
        });
        const run = meta.adapter(buildConfig(), { eventBus: bus });
        const [streamed] = await Promise.all([collectEvents(run), run.result]);
        // Bus must observe at least every type the stream did. The contract
        // is "all events mirrored" — assert equal counts per type to avoid
        // ordering subtleties between sync emit and async iteration.
        expect(seen.length).toBe(streamed.length);
        const streamTypes = streamed.map((e) => e.type).sort();
        const busTypes = seen.map((e) => e.type).sort();
        expect(busTypes).toEqual(streamTypes);
      },
      timeout,
    );

    it(
      'every event has source === meta.id',
      async () => {
        const run = meta.adapter(buildConfig());
        const [events] = await Promise.all([collectEvents(run), run.result]);
        for (const event of events) {
          expect(event.source).toBe(meta.id);
        }
      },
      timeout,
    );

    it(
      'events AsyncIterable terminates',
      async () => {
        const run = meta.adapter(buildConfig());
        // collectEvents itself iterates to done — if it returns, the
        // iterable terminated. Add an explicit timeout as a guard.
        const events = await withTimeout(
          collectEvents(run),
          timeout,
          'events iterable did not terminate',
        );
        expect(Array.isArray(events)).toBe(true);
        await run.result;
      },
      timeout,
    );

    it(
      'events is single-consumer — second iteration attempt throws',
      async () => {
        const run = meta.adapter(buildConfig());
        // First call must succeed.
        run.events[Symbol.asyncIterator]();
        // Second call must throw synchronously — splitting the stream
        // across two consumers is a silent bug, so the protocol fails
        // loudly. Callers wanting multi-cast wire AgentEventBus instead.
        expect(() => run.events[Symbol.asyncIterator]()).toThrow();
        // Drain so the run completes before the test ends.
        await run.result.catch(() => undefined);
      },
      timeout,
    );

    it(
      'events iterator return() cleanly closes the stream',
      async () => {
        const run = meta.adapter(buildConfig());
        const iter = run.events[Symbol.asyncIterator]();
        // Pull at least one event so the run is in flight, then abandon.
        await withTimeout(iter.next(), timeout, 'first next() did not resolve');
        await iter.return?.();
        // Invariant: result still resolves. Whether the run was aborted
        // by the early return is an adapter-design choice (mockAgent
        // aborts; inferenceAgent lets the run complete) — but `result`
        // must not deadlock either way.
        const result = await withTimeout(
          run.result,
          timeout,
          'result did not resolve after iterator.return()',
        );
        expect(result).toBeDefined();
      },
      timeout,
    );

    it(
      'result resolves even when events is never iterated',
      async () => {
        const run = meta.adapter(buildConfig());
        // No collectEvents call — adapters that block on consumption
        // would deadlock here. The protocol requires events to queue
        // (or drop) without blocking the producer.
        const result = await withTimeout(
          run.result,
          timeout,
          'result did not resolve without events iteration',
        );
        expect(result).toBeDefined();
      },
      timeout,
    );

    if (buildErrorConfig) {
      it(
        'result resolves rather than rejects on adapter-internal error',
        async () => {
          const run = meta.adapter(buildErrorConfig());
          let threw = false;
          let result;
          try {
            const [collected, r] = await Promise.all([collectEvents(run), run.result]);
            result = r;
            const errorBeforeEnd = collected.some(
              (e, i) =>
                e.type === 'error' &&
                collected.findIndex((x) => x.type === 'agent_end') > i,
            );
            expect(errorBeforeEnd).toBe(true);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
          expect(result?.finishReason).toBe('error');
        },
        timeout,
      );
    }

    if (meta.capabilities.resumption !== 'none') {
      it(
        'agent_start or agent_end carries a resumeToken whose kind matches the declared resumption',
        async () => {
          const run = meta.adapter(buildConfig());
          const [events] = await Promise.all([collectEvents(run), run.result]);
          const lifecycle = events.filter(
            (e): e is Extract<AgentEvent, { type: 'agent_start' | 'agent_end' }> =>
              e.type === 'agent_start' || e.type === 'agent_end',
          );
          const token = lifecycle.map((e) => e.resumeToken).find((t) => t !== undefined);
          expect(token).toBeDefined();
          if (token) {
            expect(token.kind).toBe(meta.capabilities.resumption);
          }
        },
        timeout,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function collectEvents(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of run.events) {
    out.push(event);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${label} after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
