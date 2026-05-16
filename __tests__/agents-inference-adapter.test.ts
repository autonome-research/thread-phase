/**
 * Tests for the `inferenceAgent` AgentAdapter — the reference adapter
 * wrapping `runAgentWithTools`.
 *
 * We mock the OpenAI client at the same seam the runner-level tests use
 * (`makeClient` returns a stub `client` whose `chat.completions.create`
 * iterates pre-canned chunks). Mocking that low keeps the adapter's
 * translation logic under test against the real runner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { inferenceAgent, type InferenceAgentConfig } from '../src/agents/inference-adapter.js';
import { createEventBus } from '../src/agents/event-bus.js';
import type { AgentConfig, AgentRunnerOptions } from '../src/agent/index.js';
import type { ToolExecutor, ToolResult } from '../src/messages.js';
import type { AgentEvent } from '../src/agents/protocol.js';

// ---------------------------------------------------------------------------
// Mock chunk builders — minimal subset of ChatCompletionChunk that the
// runner inspects.
// ---------------------------------------------------------------------------

const contentChunk = (delta: string, finishReason: string | null = null) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [{ index: 0, delta: { content: delta }, finish_reason: finishReason }],
});

const toolStartChunk = (
  index: number,
  id: string,
  name: string,
  argsFragment = '',
  finishReason: string | null = null,
) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [{ index, id, type: 'function', function: { name, arguments: argsFragment } }],
      },
      finish_reason: finishReason,
    },
  ],
});

const usageChunk = (prompt: number, completion: number) => ({
  id: 'c',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'm',
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
});

// Mock OpenAI client that hands out pre-canned streams in sequence.
function makeClient(streams: Array<unknown[]>): { client: any } {
  let i = 0;
  const client = {
    chat: {
      completions: {
        create: async (_body: any, options: any) => {
          const chunks = streams[i++] ?? [];
          if (options?.signal?.aborted) {
            const err = new Error(options.signal.reason ?? 'aborted');
            (err as any).name = 'AbortError';
            throw err;
          }
          return {
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) {
                if (options?.signal?.aborted) {
                  const err = new Error(options.signal.reason ?? 'aborted');
                  (err as any).name = 'AbortError';
                  throw err;
                }
                yield c;
              }
            },
          };
        },
      },
    },
  };
  return { client };
}

const noToolExecutor: ToolExecutor = {
  execute: async (): Promise<ToolResult> => ({ toolCallId: '', content: '' }),
};

const baseAgentConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: 'test-agent',
  systemPrompt: 'system',
  model: 'mock-model',
  tools: [],
  maxToolRounds: 3,
  maxTokens: 1024,
  ...overrides,
});

const cfg = (
  client: any,
  overrides: Partial<InferenceAgentConfig> = {},
): InferenceAgentConfig => ({
  config: baseAgentConfig(),
  messages: [{ role: 'user', content: 'hi' }],
  runnerOptions: { client, toolExecutor: noToolExecutor } as Omit<
    AgentRunnerOptions,
    'signal' | 'onStreamEvent'
  >,
  ...overrides,
});

async function collectEvents(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of run.events) out.push(e);
  return out;
}

describe('inferenceAgent — happy path', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('returns an AgentRunResult with finishReason=stop', async () => {
    const { client } = makeClient([[contentChunk('hello', 'stop'), usageChunk(5, 1)]]);
    const run = inferenceAgent.adapter(cfg(client));
    const result = await run.result;
    expect(result.text).toBe('hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
    expect(result.executedToolCalls).toEqual([]);
  });

  it('emits agent_start first and agent_end last with text events between', async () => {
    const { client } = makeClient([[contentChunk('a'), contentChunk('b', 'stop'), usageChunk(1, 1)]]);
    const run = inferenceAgent.adapter(cfg(client));
    const events = await collectEvents(run);
    expect(events[0]?.type).toBe('agent_start');
    expect(events.at(-1)?.type).toBe('agent_end');
    const textDeltas = events
      .filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text')
      .map((e) => e.delta);
    expect(textDeltas).toEqual(['a', 'b']);
    const end = events.at(-1) as Extract<AgentEvent, { type: 'agent_end' }>;
    expect(end.reason).toBe('stop');
  });

  it('every event carries source=inference', async () => {
    const { client } = makeClient([[contentChunk('x', 'stop'), usageChunk(1, 1)]]);
    const run = inferenceAgent.adapter(cfg(client));
    const events = await collectEvents(run);
    for (const e of events) expect(e.source).toBe('inference');
  });

  it('propagates traceId onto every event', async () => {
    const { client } = makeClient([[contentChunk('x', 'stop'), usageChunk(1, 1)]]);
    const run = inferenceAgent.adapter(cfg(client), {} as never);
    // Re-create with options.
    const run2 = inferenceAgent.adapter(cfg(client), { traceId: 'trace-123' });
    void run;
    const events = await collectEvents(run2);
    expect(events.every((e) => e.traceId === 'trace-123')).toBe(true);
  });
});

describe('inferenceAgent — tool calls', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('translates tool_call_started/complete and emits turn_end', async () => {
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
    const { client } = makeClient([
      [toolStartChunk(0, 'call_1', 'echo', '{"msg":"hi"}', 'tool_calls'), usageChunk(5, 2)],
      [contentChunk('done', 'stop'), usageChunk(5, 1)],
    ]);
    const exec: ToolExecutor = {
      execute: async (_n, id) => ({ toolCallId: id, content: 'echoed' }),
    };
    const run = inferenceAgent.adapter(
      cfg(client, {
        config: baseAgentConfig({ tools: [tool] }),
        messages: [{ role: 'user', content: 'use echo' }],
        runnerOptions: { client, toolExecutor: exec } as Omit<
          AgentRunnerOptions,
          'signal' | 'onStreamEvent'
        >,
      }),
    );
    const events = await collectEvents(run);
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    const turnEnds = events.filter(
      (e): e is Extract<AgentEvent, { type: 'turn_end' }> => e.type === 'turn_end',
    );
    expect(turnEnds.length).toBeGreaterThanOrEqual(2);
    expect(turnEnds[0]?.toolCallCount).toBe(1);
    const toolCall = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call',
    );
    expect(toolCall).toMatchObject({ id: 'call_1', name: 'echo', input: { msg: 'hi' } });
    const toolResult = events.find(
      (e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result',
    );
    expect(toolResult).toMatchObject({ id: 'call_1', name: 'echo', isError: false });
  });
});

describe('inferenceAgent — cancellation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('returns finishReason=aborted when options.signal is already aborted', async () => {
    const { client } = makeClient([[contentChunk('x', 'stop')]]);
    const controller = new AbortController();
    controller.abort('test');
    const run = inferenceAgent.adapter(cfg(client), { signal: controller.signal });
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
  });

  it('returns finishReason=aborted when run.abort() is called before iteration', async () => {
    const { client } = makeClient([[contentChunk('x', 'stop')]]);
    const run = inferenceAgent.adapter(cfg(client));
    run.abort('caller-cancelled');
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
  });

  it('closes the events stream after abort', async () => {
    const { client } = makeClient([[contentChunk('x', 'stop')]]);
    const controller = new AbortController();
    controller.abort('test');
    const run = inferenceAgent.adapter(cfg(client), { signal: controller.signal });
    const events = await collectEvents(run);
    expect(events.at(-1)?.type).toBe('agent_end');
    const end = events.at(-1) as Extract<AgentEvent, { type: 'agent_end' }>;
    expect(end.reason).toBe('aborted');
  });

  it('abort() is idempotent', async () => {
    const { client } = makeClient([[contentChunk('x', 'stop')]]);
    const run = inferenceAgent.adapter(cfg(client));
    run.abort('first');
    run.abort('second');
    run.abort('third');
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
  });
});

describe('inferenceAgent — eventBus mirroring', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('mirrors events into the supplied bus AND yields them on the run iterable', async () => {
    const { client } = makeClient([[contentChunk('hi', 'stop'), usageChunk(1, 1)]]);
    const bus = createEventBus();
    const busEvents: AgentEvent[] = [];
    bus.on((e) => {
      busEvents.push(e);
    });
    const run = inferenceAgent.adapter(cfg(client), { eventBus: bus });
    const streamEvents = await collectEvents(run);
    expect(busEvents.length).toBe(streamEvents.length);
    expect(busEvents.map((e) => e.type)).toEqual(streamEvents.map((e) => e.type));
    expect(busEvents[0]?.type).toBe('agent_start');
    expect(busEvents.at(-1)?.type).toBe('agent_end');
  });
});

describe('inferenceAgent — error path', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('resolves with finishReason=error and emits an error event when the runner errors', async () => {
    // Client whose create() throws a non-abort error — the runner catches
    // it and produces a finishReason='error' result internally.
    const failingClient = {
      chat: {
        completions: {
          create: async () => {
            const err = new Error('upstream blew up');
            throw err;
          },
        },
      },
    } as any;
    const run = inferenceAgent.adapter(cfg(failingClient));
    const events = await collectEvents(run);
    const result = await run.result;
    expect(result.finishReason).toBe('error');
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.at(-1)?.type).toBe('agent_end');
    const end = events.at(-1) as Extract<AgentEvent, { type: 'agent_end' }>;
    expect(end.reason).toBe('error');
  });
});

describe('inferenceAgent — structured output', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('populates result.parsed when the agent emits a <response> block', async () => {
    const { client } = makeClient([
      [contentChunk('<response>{"answer":42}</response>', 'stop'), usageChunk(1, 1)],
    ]);
    const run = inferenceAgent.adapter(
      cfg(client, { outputSchema: { schema: { type: 'object' } } }),
    );
    const result = await run.result;
    expect(result.parsed).toEqual({ answer: 42 });
  });

  it('leaves result.parsed undefined when the response block is missing', async () => {
    const { client } = makeClient([[contentChunk('no block here', 'stop'), usageChunk(1, 1)]]);
    const run = inferenceAgent.adapter(
      cfg(client, { outputSchema: { schema: '{}' } }),
    );
    const result = await run.result;
    expect(result.parsed).toBeUndefined();
  });
});

describe('inferenceAgent — adapter metadata', () => {
  it('declares the expected capabilities', () => {
    expect(inferenceAgent.id).toBe('inference');
    expect(inferenceAgent.capabilities).toEqual({
      streaming: 'text',
      cancellation: 'cooperative',
      resumption: 'none',
      structuredOutput: 'prompted',
    });
  });
});
