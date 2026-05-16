/**
 * Claude Code adapter tests against a stream-json stub fixture.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { runAdapterConformance } from 'thread-phase/agents/test-utils';
import type { AgentEvent } from 'thread-phase/agents';

import { claudeCodeAgent, type ClaudeCodeAgentConfig } from '../src/claude-code/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = resolve(__dirname, 'fixtures/claude-code-stub.mjs');

function buildConfig(prompt = 'hello'): ClaudeCodeAgentConfig {
  return {
    cwd: __dirname,
    prompt,
    claudeExecutable: process.execPath,
    claudeArgs: [STUB, prompt],
  };
}

async function collect(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of run.events) {
    out.push(event);
  }
  return out;
}

describe('claudeCodeAgent — integration against stream-json stub', () => {
  it('emits canonical events and captures session id', async () => {
    const run = claudeCodeAgent.adapter(buildConfig('hello'));
    const events = await collect(run);
    const result = await run.result;

    expect(events[0]?.type).toBe('agent_start');
    expect(events[events.length - 1]?.type).toBe('agent_end');
    const textDeltas = events.filter((e): e is AgentEvent & { type: 'text' } => e.type === 'text');
    expect(textDeltas.map((e) => e.delta).join('')).toBe('Hello world.');
    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Hello world.');
    expect(result.resumeToken).toBeDefined();
    expect(result.resumeToken?.kind).toBe('opaque');
  }, 10_000);

  it('every event carries source === "claude-code"', async () => {
    const run = claudeCodeAgent.adapter(buildConfig('hello'));
    const events = await collect(run);
    await run.result;
    for (const event of events) {
      expect(event.source).toBe('claude-code');
    }
  }, 10_000);

  it('translates tool_use blocks to tool_call events', async () => {
    const run = claudeCodeAgent.adapter(buildConfig('force-tool'));
    const events = await collect(run);
    const result = await run.result;
    const calls = events.filter((e): e is AgentEvent & { type: 'tool_call' } => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('echo');
    expect(calls[0]?.input).toEqual({ text: 'hello' });
    expect(result.finishReason).toBe('tool_calls');
    expect(result.executedToolCalls).toHaveLength(1);
  }, 10_000);

  it('honors pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = claudeCodeAgent.adapter(buildConfig('hello'), { signal: controller.signal });
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
  }, 10_000);

  it('resolves with finishReason: "error" when stub exits non-zero', async () => {
    const run = claudeCodeAgent.adapter(buildConfig('please force-error'));
    const events = await collect(run);
    const result = await run.result;
    expect(result.finishReason).toBe('error');
    // stub emits to stderr; we expect at least one native stderr event
    const stderr = events.filter(
      (e): e is AgentEvent & { type: 'native' } =>
        e.type === 'native' && e.kind === 'claude-code:stderr',
    );
    expect(stderr.length).toBeGreaterThan(0);
  }, 10_000);

  it('declares the expected capabilities', () => {
    expect(claudeCodeAgent.id).toBe('claude-code');
    expect(claudeCodeAgent.capabilities).toEqual({
      streaming: 'text',
      cancellation: 'forceful',
      resumption: 'opaque',
      structuredOutput: 'prompted',
    });
  });
});

describe('claudeCodeAgent — conformance', () => {
  runAdapterConformance({
    meta: claudeCodeAgent,
    buildConfig: () => buildConfig('hello'),
    buildErrorConfig: () => buildConfig('please force-error'),
    timeoutMs: 10_000,
  });
});
