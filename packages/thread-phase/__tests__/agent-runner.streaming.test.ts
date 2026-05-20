/**
 * Agent runner — streaming, structured AgentRunResult, cancellation,
 * verifyResult hook, parser-mismatch warning.
 *
 * The OpenAI client is mocked: we hand the runner a fake `client` whose
 * `chat.completions.create` returns an async-iterable of pre-canned
 * `ChatCompletionChunk` objects. That's the only surface the runner
 * touches under streaming mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAgentWithTools, type AgentStreamEvent } from '../src/agent-runner.js';
import type { AgentConfig, AgentRunnerOptions } from '../src/agent-runner.js';
import type { ToolExecutor, ToolResult } from '../src/messages.js';

// ---------------------------------------------------------------------------
// Mock chunk builders — minimal subset of ChatCompletionChunk that the
// runner inspects. Using `any` here is deliberate: we don't need the full
// SDK type for a mock.
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
  argsFragment: string = '',
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
        tool_calls: [
          {
            index,
            id,
            type: 'function',
            function: { name, arguments: argsFragment },
          },
        ],
      },
      finish_reason: finishReason,
    },
  ],
});

const toolArgsChunk = (
  index: number,
  argsFragment: string,
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
        tool_calls: [{ index, function: { arguments: argsFragment } }],
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

// Build a mock OpenAI client whose .chat.completions.create returns one of
// the configured streams in sequence.
function makeClient(streams: Array<unknown[]>): { client: any; calls: any[] } {
  const calls: any[] = [];
  let i = 0;
  const client = {
    chat: {
      completions: {
        create: async (body: any, options: any) => {
          calls.push({ body, options });
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
  return { client, calls };
}

const noToolExecutor: ToolExecutor = {
  execute: async (): Promise<ToolResult> => ({ toolCallId: '', content: '' }),
};

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: 'test-agent',
  systemPrompt: 'system',
  model: 'mock-model',
  tools: [],
  maxToolRounds: 3,
  maxTokens: 1024,
  ...overrides,
});

describe('runAgentWithTools — streaming + structured result', () => {
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

  it('accumulates content deltas into final text', async () => {
    const { client } = makeClient([
      [
        contentChunk('Hello, '),
        contentChunk('world!', 'stop'),
        usageChunk(10, 5),
      ],
    ]);
    const result = await runAgentWithTools(
      baseConfig(),
      [{ role: 'user', content: 'hi' }],
      { client, toolExecutor: noToolExecutor } as AgentRunnerOptions,
    );
    expect(result.text).toBe('Hello, world!');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.executedToolCalls).toEqual([]);
  });

  it('emits content_delta stream events as chunks arrive', async () => {
    const { client } = makeClient([
      [contentChunk('one '), contentChunk('two ', null), contentChunk('three', 'stop')],
    ]);
    const events: AgentStreamEvent[] = [];
    await runAgentWithTools(
      baseConfig(),
      [{ role: 'user', content: 'hi' }],
      {
        client,
        toolExecutor: noToolExecutor,
        onStreamEvent: (e) => events.push(e),
      } as AgentRunnerOptions,
    );
    const deltas = events.filter((e): e is Extract<AgentStreamEvent, { type: 'content_delta' }> =>
      e.type === 'content_delta',
    );
    expect(deltas.map((d) => d.delta)).toEqual(['one ', 'two ', 'three']);
    expect(events.some((e) => e.type === 'round_complete')).toBe(true);
  });

  it('reports finishReason=length when the model is truncated', async () => {
    const { client } = makeClient([
      [contentChunk('partial...', 'length'), usageChunk(50, 200)],
    ]);
    const result = await runAgentWithTools(
      baseConfig(),
      [{ role: 'user', content: 'hi' }],
      { client, toolExecutor: noToolExecutor } as AgentRunnerOptions,
    );
    expect(result.finishReason).toBe('length');
    expect(result.text).toBe('partial...');
  });

  it('records executedToolCalls and accumulates usage across rounds', async () => {
    const tool = {
      name: 'echo',
      description: 'echoes',
      inputSchema: {
        type: 'object' as const,
        properties: { msg: { type: 'string' } },
        required: ['msg'],
        additionalProperties: false,
      },
    };
    const { client } = makeClient([
      // Round 1: assistant calls echo({msg:"hi"}).
      [
        toolStartChunk(0, 'call_1', 'echo', '{"msg":"hi"}', 'tool_calls'),
        usageChunk(20, 10),
      ],
      // Round 2: assistant returns final text.
      [contentChunk('done', 'stop'), usageChunk(30, 5)],
    ]);
    const exec: ToolExecutor = {
      execute: async (_n, id) => ({ toolCallId: id, content: 'echoed' }),
    };
    const result = await runAgentWithTools(
      baseConfig({ tools: [tool] }),
      [{ role: 'user', content: 'use echo' }],
      { client, toolExecutor: exec } as AgentRunnerOptions,
    );
    expect(result.text).toBe('done');
    expect(result.finishReason).toBe('stop');
    expect(result.executedToolCalls).toHaveLength(1);
    expect(result.executedToolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'echo',
      input: { msg: 'hi' },
    });
    expect(result.usage).toEqual({
      promptTokens: 50,
      completionTokens: 15,
      totalTokens: 65,
    });
  });

  it('assembles tool-call args from multiple delta chunks', async () => {
    const tool = {
      name: 'noop',
      description: '',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        additionalProperties: false,
      },
    };
    const { client } = makeClient([
      [
        toolStartChunk(0, 'id1', 'noop', '{"a":'),
        toolArgsChunk(0, '1,'),
        toolArgsChunk(0, '"b":2}', 'tool_calls'),
        usageChunk(5, 5),
      ],
      [contentChunk('ok', 'stop'), usageChunk(5, 1)],
    ]);
    const result = await runAgentWithTools(
      baseConfig({ tools: [tool] }),
      [{ role: 'user', content: 'go' }],
      {
        client,
        toolExecutor: { execute: async (_n, id) => ({ toolCallId: id, content: 'r' }) },
      } as AgentRunnerOptions,
    );
    expect(result.executedToolCalls[0]!.input).toEqual({ a: 1, b: 2 });
  });
});

describe('runAgentWithTools — cancellation', () => {
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

  it('returns finishReason=error when signal already aborted', async () => {
    const { client } = makeClient([[contentChunk('x', 'stop')]]);
    const controller = new AbortController();
    controller.abort('test');
    const result = await runAgentWithTools(
      baseConfig(),
      [{ role: 'user', content: 'hi' }],
      { client, toolExecutor: noToolExecutor, signal: controller.signal } as AgentRunnerOptions,
    );
    expect(result.finishReason).toBe('error');
    expect(result.text).toBe('');
  });

  it('forwards signal into the OpenAI create call', async () => {
    const { client, calls } = makeClient([[contentChunk('hi', 'stop')]]);
    const controller = new AbortController();
    await runAgentWithTools(
      baseConfig(),
      [{ role: 'user', content: 'hi' }],
      { client, toolExecutor: noToolExecutor, signal: controller.signal } as AgentRunnerOptions,
    );
    expect(calls[0]!.options.signal).toBe(controller.signal);
  });

  it('catches AbortError thrown by the stream and returns error result', async () => {
    const failingClient = {
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              const err = new Error('aborted by test');
              (err as any).name = 'AbortError';
              throw err;
            },
          }),
        },
      },
    } as any;
    const result = await runAgentWithTools(
      baseConfig(),
      [{ role: 'user', content: 'hi' }],
      { client: failingClient, toolExecutor: noToolExecutor } as AgentRunnerOptions,
    );
    expect(result.finishReason).toBe('error');
    // Should include an 'aborted' activity entry.
    expect(result.activity.some((a) => a.action === 'aborted')).toBe(true);
  });
});

describe('runAgentWithTools — verifyResult hook', () => {
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

  it('runs the hook and lets it transform the result', async () => {
    const { client } = makeClient([[contentChunk('original', 'stop')]]);
    const result = await runAgentWithTools(
      baseConfig(),
      [{ role: 'user', content: 'hi' }],
      {
        client,
        toolExecutor: noToolExecutor,
        verifyResult: (r) => ({ ...r, text: 'transformed' }),
      } as AgentRunnerOptions,
    );
    expect(result.text).toBe('transformed');
  });

  it('marks finishReason=error when the hook throws', async () => {
    const { client } = makeClient([[contentChunk('claim', 'stop')]]);
    const result = await runAgentWithTools(
      baseConfig(),
      [{ role: 'user', content: 'hi' }],
      {
        client,
        toolExecutor: noToolExecutor,
        verifyResult: () => {
          throw new Error('confabulation detected');
        },
      } as AgentRunnerOptions,
    );
    expect(result.finishReason).toBe('error');
    expect(result.activity.some((a) => a.action === 'verify_failed')).toBe(true);
  });
});

describe('runAgentWithTools — parser-mismatch warning', () => {
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

  it('warns when content looks like a tool call but tool_calls is empty', async () => {
    const tool = {
      name: 'noop',
      description: '',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        additionalProperties: false,
      },
    };
    const { client } = makeClient([
      // Mis-parsed tool call leaks through as content text.
      [contentChunk('<tool_call>{"name":"noop","arguments":{}}</tool_call>', 'stop')],
    ]);
    const result = await runAgentWithTools(
      baseConfig({ tools: [tool] }),
      [{ role: 'user', content: 'go' }],
      { client, toolExecutor: noToolExecutor } as AgentRunnerOptions,
    );
    expect(result.activity.some((a) => a.action === 'parser_mismatch_warning')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('does NOT warn for ordinary text', async () => {
    const tool = {
      name: 'noop',
      description: '',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        additionalProperties: false,
      },
    };
    const { client } = makeClient([[contentChunk('plain final answer', 'stop')]]);
    const result = await runAgentWithTools(
      baseConfig({ tools: [tool] }),
      [{ role: 'user', content: 'go' }],
      { client, toolExecutor: noToolExecutor } as AgentRunnerOptions,
    );
    expect(result.activity.some((a) => a.action === 'parser_mismatch_warning')).toBe(false);
  });
});
