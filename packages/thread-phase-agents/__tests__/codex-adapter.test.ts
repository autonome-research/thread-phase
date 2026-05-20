/**
 * Codex adapter tests — mock the OpenAI client so no real API calls.
 * The adapter accepts `config.client`, so we inject a stub that returns
 * scripted ResponseStreamEvent sequences.
 */

import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses.js';

import { runAdapterConformance } from 'thread-phase/agents/test-utils';
import type { AgentEvent } from 'thread-phase/agents';

import { codexAgent, type CodexAgentConfig } from '../src/codex/index.js';

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

interface MockOptions {
  events?: ResponseStreamEvent[];
  throwOnStream?: Error;
}

function buildMockClient(opts: MockOptions = {}): OpenAI {
  const events = opts.events ?? defaultHappyPathEvents();
  const stream = (
    _params: unknown,
    streamOpts?: { signal?: AbortSignal },
  ): AsyncIterable<ResponseStreamEvent> => {
    if (opts.throwOnStream) {
      throw opts.throwOnStream;
    }
    async function* iter(): AsyncGenerator<ResponseStreamEvent> {
      for (const event of events) {
        if (streamOpts?.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        await Promise.resolve();
        yield event;
      }
    }
    return iter();
  };
  return {
    responses: { stream },
  } as unknown as OpenAI;
}

function defaultHappyPathEvents(): ResponseStreamEvent[] {
  return [
    {
      type: 'response.created',
      response: {
        id: 'resp_test_1',
        status: 'in_progress',
        usage: null,
      },
      sequence_number: 0,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.output_text.delta',
      delta: 'Hello ',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.output_text.delta',
      delta: 'world.',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      sequence_number: 2,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.completed',
      response: {
        id: 'resp_test_1',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      sequence_number: 3,
    } as unknown as ResponseStreamEvent,
  ];
}

function functionCallEvents(): ResponseStreamEvent[] {
  return [
    {
      type: 'response.created',
      response: { id: 'resp_fn_1', status: 'in_progress' },
      sequence_number: 0,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: 'fc_1',
        name: 'get_weather',
        arguments: '',
      },
      output_index: 0,
      sequence_number: 1,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.function_call_arguments.delta',
      delta: '{"city":',
      item_id: 'fc_1',
      output_index: 0,
      sequence_number: 2,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.function_call_arguments.delta',
      delta: '"Paris"}',
      item_id: 'fc_1',
      output_index: 0,
      sequence_number: 3,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.function_call_arguments.done',
      arguments: '{"city":"Paris"}',
      item_id: 'fc_1',
      output_index: 0,
      name: 'get_weather',
      sequence_number: 4,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.completed',
      response: {
        id: 'resp_fn_1',
        status: 'completed',
        usage: { input_tokens: 8, output_tokens: 12 },
      },
      sequence_number: 5,
    } as unknown as ResponseStreamEvent,
  ];
}

function reasoningEvents(): ResponseStreamEvent[] {
  return [
    {
      type: 'response.created',
      response: { id: 'resp_r', status: 'in_progress' },
      sequence_number: 0,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.reasoning_text.delta',
      delta: 'thinking step',
      item_id: 'r_1',
      output_index: 0,
      content_index: 0,
      sequence_number: 1,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.output_text.delta',
      delta: 'answer',
      item_id: 'msg_1',
      output_index: 1,
      content_index: 0,
      sequence_number: 2,
    } as unknown as ResponseStreamEvent,
    {
      type: 'response.completed',
      response: {
        id: 'resp_r',
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      sequence_number: 3,
    } as unknown as ResponseStreamEvent,
  ];
}

function baseConfig(client: OpenAI): CodexAgentConfig {
  return {
    model: 'gpt-test',
    input: 'hello',
    client,
  };
}

async function collect(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of run.events) {
    out.push(event);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codexAgent — integration against a mock client', () => {
  it('emits canonical events on happy path and captures usage', async () => {
    const run = codexAgent.adapter(baseConfig(buildMockClient()));
    const events = await collect(run);
    const result = await run.result;

    expect(events[0]?.type).toBe('agent_start');
    expect(events[events.length - 1]?.type).toBe('agent_end');
    const textDeltas = events.filter((e): e is AgentEvent & { type: 'text' } => e.type === 'text');
    expect(textDeltas.map((e) => e.delta).join('')).toBe('Hello world.');
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Hello world.');
    expect(result.usage.promptTokens).toBe(10);
    expect(result.usage.completionTokens).toBe(5);
  });

  it('emits resumeToken (response-id) on agent_end', async () => {
    const run = codexAgent.adapter(baseConfig(buildMockClient()));
    const events = await collect(run);
    const result = await run.result;

    expect(result.resumeToken).toBeDefined();
    expect(result.resumeToken?.kind).toBe('response-id');
    if (result.resumeToken?.kind === 'response-id') {
      expect(result.resumeToken.id).toBe('resp_test_1');
      expect(result.resumeToken.provider).toBe('openai');
    }
    const end = events.find((e) => e.type === 'agent_end');
    expect(end?.type).toBe('agent_end');
    if (end?.type === 'agent_end') {
      expect(end.resumeToken?.kind).toBe('response-id');
    }
  });

  it('previousResponseId emits resumeToken on agent_start', async () => {
    const config: CodexAgentConfig = {
      ...baseConfig(buildMockClient()),
      previousResponseId: 'resp_prev',
    };
    const run = codexAgent.adapter(config);
    const events = await collect(run);
    await run.result;
    const start = events.find((e) => e.type === 'agent_start');
    expect(start?.type).toBe('agent_start');
    if (start?.type === 'agent_start') {
      expect(start.resumeToken?.kind).toBe('response-id');
      if (start.resumeToken?.kind === 'response-id') {
        expect(start.resumeToken.id).toBe('resp_prev');
      }
    }
  });

  it('translates function_call output items to tool_call events', async () => {
    const run = codexAgent.adapter(
      baseConfig(buildMockClient({ events: functionCallEvents() })),
    );
    const events = await collect(run);
    const result = await run.result;

    const calls = events.filter((e): e is AgentEvent & { type: 'tool_call' } => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('fc_1');
    expect(calls[0]?.name).toBe('get_weather');
    expect(calls[0]?.input).toEqual({ city: 'Paris' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.executedToolCalls).toHaveLength(1);
  });

  it('emits thinking events for reasoning_text deltas', async () => {
    const run = codexAgent.adapter(
      baseConfig(buildMockClient({ events: reasoningEvents() })),
    );
    const events = await collect(run);
    await run.result;
    const thinking = events.filter((e): e is AgentEvent & { type: 'thinking' } => e.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.delta).toBe('thinking step');
  });

  it('honors pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = codexAgent.adapter(baseConfig(buildMockClient()), {
      signal: controller.signal,
    });
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
  });

  it('resolves with finishReason: "error" when the SDK throws on stream', async () => {
    const run = codexAgent.adapter(
      baseConfig(buildMockClient({ throwOnStream: new Error('mock SDK boom') })),
    );
    const events = await collect(run);
    const result = await run.result;
    expect(result.finishReason).toBe('error');
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('every event carries source === "codex"', async () => {
    const run = codexAgent.adapter(baseConfig(buildMockClient()));
    const events = await collect(run);
    await run.result;
    for (const event of events) {
      expect(event.source).toBe('codex');
    }
  });

  it('declares the expected capabilities', () => {
    expect(codexAgent.id).toBe('codex');
    expect(codexAgent.capabilities).toEqual({
      streaming: 'text',
      cancellation: 'cooperative',
      resumption: 'response-id',
      structuredOutput: 'prompted',
    });
  });
});

describe('codexAgent — conformance', () => {
  runAdapterConformance({
    meta: codexAgent,
    buildConfig: () => baseConfig(buildMockClient()),
    buildErrorConfig: () =>
      baseConfig(buildMockClient({ throwOnStream: new Error('mock SDK boom') })),
    timeoutMs: 5_000,
  });
});
