/**
 * mockAgent unit tests, plus a passthrough that runs the conformance suite
 * against the mock to validate the suite itself.
 */

import { describe, it, expect } from 'vitest';
import {
  createMockAgent,
  MOCK_DEFAULT_CAPABILITIES,
  runAdapterConformance,
  type MockAgentConfig,
} from '../src/agents/test-utils/index.js';
import { createEventBus } from '../src/agents/event-bus.js';
import type { AgentEvent, AgentRunResult } from '../src/agents/protocol.js';

const emptyResult = (
  overrides: Partial<AgentRunResult> = {},
): AgentRunResult => ({
  text: '',
  finishReason: 'stop',
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  executedToolCalls: [],
  ...overrides,
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

describe('createMockAgent', () => {
  it('declares the requested id and default capabilities', () => {
    const meta = createMockAgent();
    expect(meta.id).toBe('mock');
    expect(meta.capabilities).toEqual(MOCK_DEFAULT_CAPABILITIES);
  });

  it('honors id and capability overrides', () => {
    const meta = createMockAgent({
      id: 'mock-2',
      capabilities: { resumption: 'opaque' },
    });
    expect(meta.id).toBe('mock-2');
    expect(meta.capabilities.resumption).toBe('opaque');
    // Unspecified caps remain at defaults.
    expect(meta.capabilities.cancellation).toBe('cooperative');
  });

  it('emits scripted events verbatim, framed by agent_start and agent_end', async () => {
    const meta = createMockAgent();
    const scripted: AgentEvent[] = [
      { type: 'text', source: 'mock', delta: 'hello ' },
      { type: 'text', source: 'mock', delta: 'world' },
      {
        type: 'turn_end',
        source: 'mock',
        assistantText: 'hello world',
        toolCallCount: 0,
      },
    ];
    const run = meta.adapter({
      events: scripted,
      result: emptyResult({ text: 'hello world' }),
    });
    const events = await collect(run.events);
    await run.result;

    expect(events[0]!.type).toBe('agent_start');
    expect(events[events.length - 1]!.type).toBe('agent_end');
    // Middle slice matches scripted contents (modulo source stamping).
    const middle = events.slice(1, -1);
    expect(middle.map((e) => e.type)).toEqual(['text', 'text', 'turn_end']);
    expect((middle[0] as { delta: string }).delta).toBe('hello ');
    expect((middle[1] as { delta: string }).delta).toBe('world');
  });

  it('events stream terminates after agent_end', async () => {
    const meta = createMockAgent();
    const run = meta.adapter({ events: [], result: emptyResult() });
    const iter = run.events[Symbol.asyncIterator]();
    const seen: AgentEvent[] = [];
    while (true) {
      const step = await iter.next();
      if (step.done) break;
      seen.push(step.value);
      if (seen.length > 10) throw new Error('stream did not terminate');
    }
    expect(seen[seen.length - 1]!.type).toBe('agent_end');
  });

  it('resolves result with the scripted value', async () => {
    const meta = createMockAgent();
    const scriptedResult = emptyResult({
      text: 'final',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    const run = meta.adapter({ events: [], result: scriptedResult });
    await collect(run.events);
    const result = await run.result;
    expect(result.text).toBe('final');
    expect(result.usage.totalTokens).toBe(15);
  });

  it('honors abort() — finishReason becomes "aborted"', async () => {
    const meta = createMockAgent();
    const scripted: AgentEvent[] = Array.from({ length: 20 }, (_, i) => ({
      type: 'text' as const,
      source: 'mock',
      delta: `chunk-${i}`,
    }));
    const run = meta.adapter({
      events: scripted,
      result: emptyResult({ finishReason: 'stop' }),
      perEventDelayMs: 5,
    });
    setTimeout(() => {
      run.abort();
      run.abort(); // idempotent
    }, 0);
    const events = await collect(run.events);
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
    const end = events.find((e) => e.type === 'agent_end');
    expect(end && end.type === 'agent_end' && end.reason).toBe('aborted');
  });

  it('honors options.signal — pre-aborted signal short-circuits to aborted', async () => {
    const meta = createMockAgent();
    const ctrl = new AbortController();
    ctrl.abort();
    const run = meta.adapter(
      {
        events: [{ type: 'text', source: 'mock', delta: 'should-not-fire' }],
        result: emptyResult(),
      },
      { signal: ctrl.signal },
    );
    const events = await collect(run.events);
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
    // No `text` event should make it through.
    expect(events.some((e) => e.type === 'text')).toBe(false);
  });

  it('mirrors events to options.eventBus', async () => {
    const meta = createMockAgent();
    const bus = createEventBus();
    const observed: AgentEvent[] = [];
    bus.on((e) => {
      observed.push(e);
    });
    const run = meta.adapter(
      {
        events: [{ type: 'text', source: 'mock', delta: 'hi' }],
        result: emptyResult(),
      },
      { eventBus: bus },
    );
    const events = await collect(run.events);
    await run.result;
    expect(observed.length).toBe(events.length);
    expect(observed.map((e) => e.type)).toEqual(events.map((e) => e.type));
  });

  it('stamps source = meta.id on every emitted event', async () => {
    const meta = createMockAgent({ id: 'mock-stamp' });
    const run = meta.adapter({
      events: [
        // Deliberately use a wrong source — the adapter must overwrite it.
        { type: 'text', source: 'wrong', delta: 'x' },
      ],
      result: emptyResult(),
    });
    const events = await collect(run.events);
    await run.result;
    for (const e of events) expect(e.source).toBe('mock-stamp');
  });

  it('throws synchronously when throwOnConstruct is set', () => {
    const meta = createMockAgent();
    const err = new Error('construction blew up');
    expect(() =>
      meta.adapter({
        events: [],
        result: emptyResult(),
        throwOnConstruct: err,
      }),
    ).toThrow('construction blew up');
  });
});

// ---------------------------------------------------------------------------
// Conformance suite self-test — proves runAdapterConformance works against
// at least one adapter. We don't pass `buildErrorConfig` because the mock
// has no internal-error mode; instead, we cover the resolve-on-error path
// indirectly via the abort/signal tests.
// ---------------------------------------------------------------------------

const conformanceMeta = createMockAgent({ id: 'mock-conformance' });

const buildConfig = (): MockAgentConfig => ({
  events: [
    { type: 'text', source: 'mock-conformance', delta: 'hello' },
    {
      type: 'turn_end',
      source: 'mock-conformance',
      assistantText: 'hello',
      toolCallCount: 0,
    },
  ],
  result: emptyResult({ text: 'hello', finishReason: 'stop' }),
});

runAdapterConformance({
  meta: conformanceMeta,
  buildConfig,
});

// Second pass: an adapter that advertises resumption to exercise the
// conditional resumeToken assertion.
const conformanceMetaResume = createMockAgent({
  id: 'mock-conformance-resume',
  capabilities: { resumption: 'opaque' },
});

runAdapterConformance({
  meta: conformanceMetaResume,
  buildConfig: (): MockAgentConfig => ({
    events: [],
    result: emptyResult({
      finishReason: 'stop',
      resumeToken: { kind: 'opaque', data: 'session-42' },
    }),
  }),
});
