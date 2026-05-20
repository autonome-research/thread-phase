import { describe, it, expect } from 'vitest';
import {
  appendEvent,
  createEventBus,
  createThread,
  resumeTokenFor,
  setResumeToken,
  withThread,
  type AgentEvent,
  type AgentRun,
  type AgentRunResult,
  type Thread,
} from '../src/agents/index.js';
import { createMockAgent, type MockAgentConfig } from '../src/agents/test-utils/index.js';

function configWithFinalResumeToken(): MockAgentConfig {
  return {
    events: [{ type: 'text', source: 'mock', delta: 'ok' }],
    result: {
      text: 'ok',
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      executedToolCalls: [],
      resumeToken: { kind: 'opaque', data: 'session-after-run' },
    } as AgentRunResult,
  };
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of run.events) out.push(event);
  return out;
}

describe('withThread', () => {
  it('does not call applyResume when the thread has no token for this adapter', () => {
    let applyCalled = false;
    const mock = createMockAgent({ id: 'mock-x' });
    const thread = createThread();
    const wrapped = withThread(mock, thread, {
      applyResume: () => {
        applyCalled = true;
        return {} as MockAgentConfig;
      },
    });
    wrapped.adapter(configWithFinalResumeToken());
    expect(applyCalled).toBe(false);
  });

  it('injects the resume token when one is set in the thread', async () => {
    const mock = createMockAgent({ id: 'mock-x' });
    const thread = createThread();
    setResumeToken(thread, 'mock-x', { kind: 'opaque', data: 'prior-session' });
    let injectedToken: string | null = null;
    const wrapped = withThread(mock, thread, {
      applyResume: (cfg, token) => {
        if (token.kind === 'opaque') injectedToken = token.data;
        return cfg;
      },
    });
    const run = wrapped.adapter(configWithFinalResumeToken());
    await collect(run);
    await run.result;
    expect(injectedToken).toBe('prior-session');
  });

  it('appends every emitted event to thread.events', async () => {
    const mock = createMockAgent({ id: 'mock-x' });
    const thread = createThread();
    const wrapped = withThread(mock, thread);
    const run = wrapped.adapter(configWithFinalResumeToken());
    await collect(run);
    await run.result;
    const types = thread.events.map((e) => e.type);
    expect(types).toContain('agent_start');
    expect(types).toContain('text');
    expect(types).toContain('agent_end');
  });

  it('writes resumeToken from agent_end back to thread.resumeTokens', async () => {
    const mock = createMockAgent({ id: 'mock-x', capabilities: { resumption: 'opaque' } });
    const thread = createThread();
    expect(resumeTokenFor(thread, 'mock-x')).toBeUndefined();
    const wrapped = withThread(mock, thread);
    const run = wrapped.adapter(configWithFinalResumeToken());
    await collect(run);
    await run.result;
    const token = resumeTokenFor(thread, 'mock-x');
    expect(token).toBeDefined();
    expect(token?.kind).toBe('opaque');
    if (token?.kind === 'opaque') {
      expect(token.data).toBe('session-after-run');
    }
  });

  it('mirrors every event to the caller-supplied eventBus too', async () => {
    const mock = createMockAgent({ id: 'mock-x' });
    const thread = createThread();
    const bus = createEventBus();
    const seen: AgentEvent[] = [];
    bus.on((event) => seen.push(event));
    const wrapped = withThread(mock, thread);
    const run = wrapped.adapter(configWithFinalResumeToken(), { eventBus: bus });
    await collect(run);
    await run.result;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.map((e) => e.type)).toContain('agent_start');
  });

  it('works without applyResume when the adapter has no resumption capability', async () => {
    const mock = createMockAgent({
      id: 'mock-x',
      capabilities: { resumption: 'none' },
    });
    const thread = createThread();
    const wrapped = withThread(mock, thread); // no applyResume
    const run = wrapped.adapter(configWithFinalResumeToken());
    await collect(run);
    await run.result;
    // Events still mirrored even though there's nothing to resume.
    expect(thread.events.length).toBeGreaterThan(0);
  });

  it('accumulates events from multiple sequential runs into the same thread', async () => {
    const mock = createMockAgent({ id: 'mock-x' });
    const thread = createThread();
    const wrapped = withThread(mock, thread);

    const runA = wrapped.adapter(configWithFinalResumeToken());
    await collect(runA);
    await runA.result;
    const firstRunEventCount = thread.events.length;
    expect(firstRunEventCount).toBeGreaterThan(0);

    const runB = wrapped.adapter(configWithFinalResumeToken());
    await collect(runB);
    await runB.result;
    expect(thread.events.length).toBeGreaterThan(firstRunEventCount);
  });

  it('mutates the supplied thread in place — appendEvent semantics', async () => {
    const mock = createMockAgent({ id: 'mock-x' });
    const thread: Thread = createThread();
    // Seed an existing event to prove we're appending, not replacing.
    appendEvent(thread, {
      type: 'native',
      source: 'seed',
      kind: 'before-run',
      payload: null,
    });
    const wrapped = withThread(mock, thread);
    const run = wrapped.adapter(configWithFinalResumeToken());
    await collect(run);
    await run.result;
    expect(thread.events[0]?.type).toBe('native');
    expect(thread.events[0]?.source).toBe('seed');
    // Plus the adapter's events after.
    expect(thread.events.length).toBeGreaterThan(1);
  });
});
