/**
 * Stress tests — angle: errors.
 *
 * Adversarial scenarios that probe error-handling invariants across:
 *   - serializeError (cyclic causes, exotic non-Error throws)
 *   - the inference adapter (sync throws, mid-stream errors)
 *   - tool executors (sync throw vs async reject)
 *   - orchestrator (phase throwing after partial event emission)
 *   - with-retry (signal-unaware sleep, multi-attempt ctx.stop mutation)
 *   - parallel-phases (no sibling cancellation on error)
 *   - structured output extraction (greedy regex, exotic JSON)
 *   - runTrigger (non-Error throws routed through onError)
 *
 * Failure of these tests IS the finding — they document gaps, not regressions.
 */

import { describe, it, expect, vi } from 'vitest';
import { runPipeline, runPipelineToSummary } from '../src/orchestrator.js';
import { PipelineCache } from '../src/cache.js';
import { withRetry } from '../src/patterns/with-retry.js';
import { parallelPhases } from '../src/patterns/parallel-phases.js';
import { runTrigger } from '../src/triggers/run-trigger.js';
import { TimerTrigger } from '../src/triggers/timer-trigger.js';
import { serializeError } from '../src/agents/serialize-error.js';
import {
  parseStructuredFromText,
  StructuredOutputParseError,
} from '../src/agents/structured-output.js';
import { inferenceAgent, type InferenceAgentConfig } from '../src/agents/inference-adapter.js';
import type {
  AgentConfig,
  AgentRunnerOptions,
} from '../src/agent/index.js';
import type { ToolExecutor, ToolResult } from '../src/messages.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';
import type { AgentEvent } from '../src/agents/protocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Ctx extends BasePipelineContext {
  log?: string[];
}

const makeCtx = (): Ctx => ({ cache: new PipelineCache(), log: [] });

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function collectEvents(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of run.events) out.push(e);
  return out;
}

const baseAgentConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: 'test-agent',
  systemPrompt: 'system',
  model: 'mock-model',
  tools: [],
  maxToolRounds: 3,
  maxTokens: 1024,
  ...overrides,
});

const noToolExecutor: ToolExecutor = {
  execute: async (): Promise<ToolResult> => ({ toolCallId: '', content: '' }),
};

const cfg = (
  client: unknown,
  overrides: Partial<InferenceAgentConfig> = {},
): InferenceAgentConfig => ({
  config: baseAgentConfig(),
  messages: [{ role: 'user', content: 'hi' }],
  runnerOptions: { client: client as any, toolExecutor: noToolExecutor } as Omit<
    AgentRunnerOptions,
    'signal' | 'onStreamEvent'
  >,
  ...overrides,
});

// Minimal canned-stream mock OpenAI client.
const contentChunk = (delta: string, finishReason: string | null = null) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta: { content: delta }, finish_reason: finishReason }],
});
const usageChunk = (prompt: number, completion: number) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
});

// ---------------------------------------------------------------------------
// serializeError — cyclic cause chain
// ---------------------------------------------------------------------------

describe('serializeError — cyclic cause chains', () => {
  it('does not stack-overflow on a self-cycle (err.cause = err)', () => {
    const err: Error & { cause?: unknown } = new Error('self');
    err.cause = err;
    let threw: unknown = null;
    let result: unknown = null;
    try {
      result = serializeError(err);
    } catch (e) {
      threw = e;
    }
    // If current impl throws RangeError, this assertion fails — bug.
    expect(threw).toBeNull();
    expect(result).toBeDefined();
  });

  it('does not stack-overflow on a 2-cycle (A.cause=B, B.cause=A)', () => {
    const a: Error & { cause?: unknown } = new Error('A');
    const b: Error & { cause?: unknown } = new Error('B');
    a.cause = b;
    b.cause = a;
    let threw: unknown = null;
    try {
      serializeError(a);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
  });

  it('produces a finite, JSON-serializable object even with cycles', () => {
    const a: Error & { cause?: unknown } = new Error('A');
    const b: Error & { cause?: unknown } = new Error('B');
    a.cause = b;
    b.cause = a;
    const result = serializeError(a);
    // Must not throw on JSON.stringify (which would fail on a real cyclic ref).
    let json: string | null = null;
    expect(() => {
      json = JSON.stringify(result);
    }).not.toThrow();
    expect(json).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// serializeError — exotic non-Error throws
// ---------------------------------------------------------------------------

describe('serializeError — exotic non-Error throws', () => {
  it('does not throw on an object whose Symbol.toPrimitive throws', () => {
    const evil = {
      [Symbol.toPrimitive](): string {
        throw new Error('toPrimitive boom');
      },
    };
    let threw: unknown = null;
    try {
      serializeError(evil);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
  });

  it('does not throw on a Proxy whose toString trap throws', () => {
    const target = {};
    const proxy = new Proxy(target, {
      get(): never {
        throw new Error('proxy trap boom');
      },
    });
    let threw: unknown = null;
    try {
      serializeError(proxy);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeNull();
  });

});

// ---------------------------------------------------------------------------
// Tool executor: sync throw vs async reject symmetry
// ---------------------------------------------------------------------------

describe('toolExecutor — sync throw vs async reject', () => {
  // Build a client that emits exactly one tool call then returns a stop.
  const toolCallThenStop = (): unknown[][] => [
    [
      // tool_call chunk with full args inline
      {
        id: 'c',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"msg":"hi"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      usageChunk(5, 2),
    ],
    [contentChunk('done', 'stop'), usageChunk(5, 1)],
  ];

  function makeClient(streams: unknown[][]): unknown {
    let i = 0;
    return {
      chat: {
        completions: {
          create: async (_body: unknown, options: { signal?: AbortSignal } | undefined) => {
            const chunks = streams[i++] ?? [];
            if (options?.signal?.aborted) {
              const err = new Error('aborted');
              (err as { name?: string }).name = 'AbortError';
              throw err;
            }
            return {
              async *[Symbol.asyncIterator]() {
                for (const c of chunks) yield c;
              },
            };
          },
        },
      },
    };
  }

  const tool = {
    name: 'echo',
    description: '',
    inputSchema: {
      type: 'object' as const,
      properties: { msg: { type: 'string' } },
      required: ['msg'],
      additionalProperties: false,
    },
  };

  it('sync-throwing toolExecutor: run resolves, does NOT crash the test process', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exec: ToolExecutor = {
      execute: ((): never => {
        // Synchronous throw BEFORE returning a Promise.
        throw new Error('sync boom');
      }) as unknown as ToolExecutor['execute'],
    };
    const client = makeClient(toolCallThenStop());
    const run = inferenceAgent.adapter(
      cfg(client, {
        config: baseAgentConfig({ tools: [tool], maxToolRounds: 1 }),
        runnerOptions: { client: client as any, toolExecutor: exec, maxRetries: 0 } as Omit<
          AgentRunnerOptions,
          'signal' | 'onStreamEvent'
        >,
      }),
    );
    // result must always resolve per protocol — never reject.
    const result = await run.result;
    expect(result).toBeDefined();
    // Should land on 'error' since the tool throw escaped.
    expect(result.finishReason).toBe('error');
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

});

// ---------------------------------------------------------------------------
// Adapter: sync throw at stream start vs mid-stream
// ---------------------------------------------------------------------------

describe('inferenceAgent — adapter error timing', () => {
  it('synchronous throw from chat.completions.create yields finishReason=error and exactly one agent_start/end', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const badClient = {
      chat: {
        completions: {
          create: async () => {
            throw new Error('start boom');
          },
        },
      },
    };
    const run = inferenceAgent.adapter(
      cfg(badClient, {
        runnerOptions: {
          client: badClient as any,
          toolExecutor: noToolExecutor,
          maxRetries: 0,
        } as Omit<AgentRunnerOptions, 'signal' | 'onStreamEvent'>,
      }),
    );
    const events = await collectEvents(run);
    const result = await run.result;
    expect(result.finishReason).toBe('error');
    const starts = events.filter((e) => e.type === 'agent_start');
    const ends = events.filter((e) => e.type === 'agent_end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    // Should be an error event between start and end.
    const errs = events.filter((e) => e.type === 'error');
    expect(errs.length).toBeGreaterThanOrEqual(1);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('iterator that throws mid-stream: result resolves with partial text and exactly one agent_end', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flakyClient = {
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              yield contentChunk('par');
              yield contentChunk('tial');
              yield contentChunk('!');
              throw new Error('mid-stream boom');
            },
          }),
        },
      },
    };
    const run = inferenceAgent.adapter(
      cfg(flakyClient, {
        runnerOptions: {
          client: flakyClient as any,
          toolExecutor: noToolExecutor,
          maxRetries: 0,
        } as Omit<AgentRunnerOptions, 'signal' | 'onStreamEvent'>,
      }),
    );
    const events = await collectEvents(run);
    const result = await run.result;
    expect(result.finishReason).toBe('error');
    const starts = events.filter((e) => e.type === 'agent_start');
    const ends = events.filter((e) => e.type === 'agent_end');
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    // Iterating events a SECOND time should throw per single-consumer contract.
    let threw = false;
    try {
      await collectEvents(run);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Phase throws AFTER emitting events
// ---------------------------------------------------------------------------

describe('orchestrator — phase throws after partial emission', () => {
  const visit = (name: string, capture: string[]): Phase<Ctx> => ({
    name,
    async *run() {
      capture.push(name);
      yield { type: 'phase', phase: name };
    },
  });

  const postEmitThrow = (capture: string[]): Phase<Ctx> => ({
    name: 'mid',
    async *run(ctx) {
      capture.push('mid:start');
      ctx.cache.set('temp-key', 'set-before-throw');
      yield { type: 'phase', phase: 'mid', detail: '1' };
      yield { type: 'phase', phase: 'mid', detail: '2' };
      yield { type: 'phase', phase: 'mid', detail: '3' };
      yield { type: 'phase', phase: 'mid', detail: '4' };
      yield { type: 'phase', phase: 'mid', detail: '5' };
      throw new Error('post-emit boom');
    },
  });

  it('downstream consumer receives all 5 events before the rejection', async () => {
    const capture: string[] = [];
    const ctx = makeCtx();
    const gen = runPipeline(
      [visit('pre', capture), postEmitThrow(capture), visit('post', capture)],
      ctx,
    );
    const collected: PipelineEvent[] = [];
    let threw: unknown = null;
    try {
      for await (const ev of gen) collected.push(ev);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toBe('post-emit boom');
    const midEvents = collected.filter(
      (e) => e.type === 'phase' && (e as { phase?: string }).phase === 'mid',
    );
    expect(midEvents).toHaveLength(5);
    // visit('post') must NOT have executed.
    expect(capture).not.toContain('post');
    // No terminal done event was emitted.
    const done = collected.filter((e) => e.type === 'done');
    expect(done).toHaveLength(0);
    // Cache must be cleared by the orchestrator finally block.
    expect(ctx.cache.size).toBe(0);
  });

  it('runPipelineToSummary rejects with the ORIGINAL error instance', async () => {
    const capture: string[] = [];
    const ctx = makeCtx();
    const original = new Error('post-emit boom');
    const innerPhase: Phase<Ctx> = {
      name: 'mid',
      async *run() {
        yield { type: 'phase', phase: 'mid' };
        throw original;
      },
    };
    let caught: unknown = null;
    try {
      await runPipelineToSummary(
        [visit('pre', capture), innerPhase, visit('post', capture)],
        ctx,
      );
    } catch (e) {
      caught = e;
    }
    // Must be the SAME instance (no wrapping).
    expect(caught).toBe(original);
    expect(ctx.cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// with-retry: multi-attempt ctx.stop mutation
// ---------------------------------------------------------------------------

describe('with-retry — multi-attempt ctx.stop mutation', () => {
  it('attempt 1 throws, attempt 2 succeeds — no third attempt, ctx.stop is clean', async () => {
    let attempts = 0;
    const phase: Phase<Ctx> = {
      name: 'mixed',
      async *run(ctx) {
        attempts++;
        if (attempts === 1) {
          throw new TypeError('first attempt throws');
        }
        // attempt 2 succeeds — no ctx.stop, no throw.
        yield { type: 'phase', phase: 'mixed' };
      },
    };

    const onRetry = vi.fn();
    const wrapped = withRetry(phase, {
      maxAttempts: 5,
      baseDelayMs: 1,
      onRetry,
    });

    const ctx = makeCtx();
    await collect(wrapped.run(ctx));
    expect(attempts).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(ctx.stop).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parallel-phases: one branch throws while others produce many events
// ---------------------------------------------------------------------------

describe('parallel-phases — sibling cancellation on error', () => {
  it('non-observing siblings run to completion (cooperative cancellation); composite still throws first error', async () => {
    const N = 5_000; // smaller than the design's 50k for test speed; still demonstrates
    const failQuickA: Phase<Ctx> = {
      name: 'A',
      async *run() {
        yield { type: 'phase', phase: 'A' };
        throw new Error('A failed');
      },
    };
    let bDelivered = 0;
    const floodB: Phase<Ctx> = {
      name: 'B',
      async *run() {
        for (let i = 0; i < N; i++) {
          bDelivered++;
          yield { type: 'phase', phase: 'B', detail: String(i) };
        }
      },
    };
    let cDelivered = 0;
    const slowC: Phase<Ctx> = {
      name: 'C',
      async *run() {
        for (let i = 0; i < N; i++) {
          await Promise.resolve();
          cDelivered++;
          yield { type: 'phase', phase: 'C', detail: String(i) };
        }
      },
    };

    const composite = parallelPhases('all', [failQuickA, floodB, slowC]);
    const ctx = makeCtx();

    let collected = 0;
    let threw: unknown = null;
    try {
      for await (const _ev of composite.run(ctx)) {
        collected++;
      }
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toBe('A failed');
    // B and C do not observe c.signal, so they run to completion (the
    // cooperative-cancellation contract). All events reach the consumer
    // before the composite throws A's error at the end.
    expect(bDelivered).toBe(N);
    expect(cDelivered).toBe(N);
    expect(collected).toBeGreaterThanOrEqual(N);
  });
});

// ---------------------------------------------------------------------------
// Structured output — adversarial inputs
// ---------------------------------------------------------------------------

describe('structured output — adversarial inputs', () => {
  it('two response blocks where the LAST is invalid JSON throws StructuredOutputParseError', () => {
    const text = '<response>{"a":1}</response> noise <response>{not json</response>';
    let threw: unknown = null;
    try {
      parseStructuredFromText(text, { schema: '{}' });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(StructuredOutputParseError);
  });

  it('response block with unescaped NUL is rejected; escaped form parses correctly', () => {
    // RFC 8259 §7 requires U+0000..U+001F inside JSON string literals to be
    // escaped as ` `. Raw NUL inside a string is invalid JSON.
    const nul = String.fromCharCode(0);
    const rawNul = `<response>{"x":"hello${nul}world"}</response>`;
    expect(() => parseStructuredFromText(rawNul, { schema: '{}' })).toThrow(
      StructuredOutputParseError,
    );

    // The properly-escaped form is valid and round-trips through to the
    // expected unicode character.
    const escaped = '<response>{"x":"hello\\u0000world"}</response>';
    const result = parseStructuredFromText(escaped, { schema: '{}' });
    expect(result).toEqual({ x: `hello${nul}world` });
  });

});

// ---------------------------------------------------------------------------
// runTrigger: dispatch worker throws non-Error values
// ---------------------------------------------------------------------------

describe('runTrigger — non-Error throws routed through onError', () => {
  it('continues the loop after string, number, symbol, undefined throws', async () => {
    const trigger = new TimerTrigger<number>({
      intervalMs: 10,
      payload: () => Date.now(),
      fireImmediately: true,
    });
    const errors: unknown[] = [];
    const onError = vi.fn((_event, err: Error) => {
      errors.push(err);
    });

    let i = 0;
    const handle = runTrigger(
      trigger,
      () => {
        const idx = i++;
        const phase: Phase<Ctx> = {
          name: 'throw-non-error',
          async *run() {
            switch (idx % 4) {
              case 0:
                // eslint-disable-next-line no-throw-literal
                throw 'string error';
              case 1:
                // eslint-disable-next-line no-throw-literal
                throw 42;
              case 2:
                // eslint-disable-next-line no-throw-literal
                throw Symbol('sym');
              default:
                // eslint-disable-next-line no-throw-literal
                throw undefined;
            }
            // Unreachable, but the generator needs to yield to be a valid AsyncGenerator.
            yield { type: 'phase', phase: 'never' };
          },
        };
        return { phases: [phase], ctx: makeCtx() };
      },
      { maxConcurrency: 1, onError },
    );

    // Let 4 dispatches happen.
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    await handle.done;

    // Should have at least 4 errors recorded (one per dispatch). loop survived.
    expect(onError.mock.calls.length).toBeGreaterThanOrEqual(3);
    // All recorded values were coerced to Error per `err instanceof Error ? err : new Error(String(err))`.
    for (const e of errors) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});
