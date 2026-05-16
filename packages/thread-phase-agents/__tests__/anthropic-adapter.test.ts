/**
 * Anthropic adapter tests — mock the SDK client so we don't touch the
 * real API. The adapter accepts `config.client`, so tests inject a stub
 * that returns scripted RawMessageStreamEvent sequences.
 */

import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages.js';

import { runAdapterConformance } from 'thread-phase/agents/test-utils';
import type { AgentEvent } from 'thread-phase/agents';

import { anthropicAgent, type AnthropicAgentConfig } from '../src/anthropic/index.js';

// ---------------------------------------------------------------------------
// Mock client builders
// ---------------------------------------------------------------------------

interface MockOptions {
  events?: RawMessageStreamEvent[];
  throwOnStream?: Error;
}

function buildMockClient(opts: MockOptions = {}): Anthropic {
  const events = opts.events ?? defaultHappyPathEvents();
  const stream = (
    _params: unknown,
    streamOpts?: { signal?: AbortSignal },
  ): AsyncIterable<RawMessageStreamEvent> => {
    if (opts.throwOnStream) {
      throw opts.throwOnStream;
    }
    async function* iter(): AsyncGenerator<RawMessageStreamEvent> {
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
    messages: { stream },
  } as unknown as Anthropic;
}

function defaultHappyPathEvents(): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: null },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello ' },
    } as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'world.' },
    } as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 } as unknown,
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as RawMessageStreamEvent,
  ];
}

function toolUseEvents(): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 8 },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'tu_1',
        name: 'get_weather',
        input: {},
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":' },
    } as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
    } as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 12 } as unknown,
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as RawMessageStreamEvent,
  ];
}

function thinkingEvents(): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5 },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'pondering...' },
    } as unknown as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 0 } as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '', citations: null },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    } as RawMessageStreamEvent,
    { type: 'content_block_stop', index: 1 } as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 8 } as unknown,
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as RawMessageStreamEvent,
  ];
}

function baseConfig(client: Anthropic): AnthropicAgentConfig {
  return {
    model: 'claude-test',
    messages: [{ role: 'user', content: 'hi' }],
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

describe('anthropicAgent — integration against a mock client', () => {
  it('emits canonical event sequence on a happy-path stream', async () => {
    const run = anthropicAgent.adapter(baseConfig(buildMockClient()));
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

  it('translates tool_use blocks to tool_call events with assembled JSON input', async () => {
    const run = anthropicAgent.adapter(
      baseConfig(buildMockClient({ events: toolUseEvents() })),
    );
    const events = await collect(run);
    const result = await run.result;

    const calls = events.filter((e): e is AgentEvent & { type: 'tool_call' } => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('tu_1');
    expect(calls[0]?.name).toBe('get_weather');
    expect(calls[0]?.input).toEqual({ city: 'Paris' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.executedToolCalls).toHaveLength(1);
  });

  it('emits thinking events for extended-thinking deltas', async () => {
    const run = anthropicAgent.adapter(
      baseConfig(buildMockClient({ events: thinkingEvents() })),
    );
    const events = await collect(run);
    await run.result;
    const thinking = events.filter((e): e is AgentEvent & { type: 'thinking' } => e.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.delta).toBe('pondering...');
  });

  it('honors pre-aborted signal — emits aborted finishReason', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = anthropicAgent.adapter(baseConfig(buildMockClient()), {
      signal: controller.signal,
    });
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
  });

  it('every event carries source === "anthropic"', async () => {
    const run = anthropicAgent.adapter(baseConfig(buildMockClient()));
    const events = await collect(run);
    await run.result;
    for (const event of events) {
      expect(event.source).toBe('anthropic');
    }
  });

  it('resolves with finishReason: "error" when the SDK throws on stream', async () => {
    const run = anthropicAgent.adapter(
      baseConfig(buildMockClient({ throwOnStream: new Error('mock SDK boom') })),
    );
    const events = await collect(run);
    const result = await run.result;
    expect(result.finishReason).toBe('error');
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('declares the expected capabilities', () => {
    expect(anthropicAgent.id).toBe('anthropic');
    expect(anthropicAgent.capabilities).toEqual({
      streaming: 'text',
      cancellation: 'cooperative',
      resumption: 'none',
      structuredOutput: 'prompted',
    });
  });
});

describe('anthropicAgent — conformance', () => {
  runAdapterConformance({
    meta: anthropicAgent,
    buildConfig: () => baseConfig(buildMockClient()),
    buildErrorConfig: () =>
      baseConfig(buildMockClient({ throwOnStream: new Error('mock SDK boom') })),
    timeoutMs: 5_000,
  });
});
