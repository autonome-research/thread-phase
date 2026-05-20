import { describe, it, expect, vi } from 'vitest';
import {
  createEventBus,
  withMemory,
  type AgentEvent,
  type AgentRun,
  type AgentRunResult,
  type MemoryProvider,
  type MemoryScope,
} from '../src/agents/index.js';
import { createMockAgent, type MockAgentConfig } from '../src/agents/test-utils/index.js';

const SCOPE: MemoryScope = { userId: 'alice' };

function happyConfig(): MockAgentConfig {
  return {
    events: [{ type: 'text', source: 'mock', delta: 'hello' }],
    result: {
      text: 'hello',
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      executedToolCalls: [],
    } as AgentRunResult,
  };
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of run.events) out.push(event);
  return out;
}

describe('withMemory', () => {
  it('is a no-op when no memoryProvider is in options', async () => {
    const recall = vi.fn();
    const remember = vi.fn();
    const provider: MemoryProvider = { recall, remember };
    const mock = createMockAgent();
    const wrapped = withMemory(mock, {
      scope: SCOPE,
      inject: (cfg) => cfg,
    });
    const run = wrapped.adapter(happyConfig()); // no options, no provider
    await collect(run);
    await run.result;
    expect(recall).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
    expect(provider).toBeDefined();
  });

  it('recalls and injects memory before invoking the inner adapter', async () => {
    let configSeenByMock: MockAgentConfig | null = null;
    const mock = createMockAgent();
    // Spy on the inner adapter to capture the config it received.
    const innerSpy = vi.spyOn(mock, 'adapter');

    const provider: MemoryProvider = {
      recall: vi.fn(async () => 'remembered context'),
      remember: vi.fn(async () => undefined),
    };

    const wrapped = withMemory(mock, {
      scope: SCOPE,
      inject: (cfg, memory) => {
        configSeenByMock = { ...cfg, events: cfg.events };
        return cfg;
      },
      query: () => 'a query',
    });

    const run = wrapped.adapter(happyConfig(), { memoryProvider: provider });
    await collect(run);
    await run.result;

    expect(provider.recall).toHaveBeenCalledWith(SCOPE, 'a query');
    expect(innerSpy).toHaveBeenCalled();
    expect(configSeenByMock).not.toBeNull();
  });

  it('passes the inject-transformed config through to the inner adapter', async () => {
    const mock = createMockAgent();
    const innerSpy = vi.spyOn(mock, 'adapter');
    const provider: MemoryProvider = {
      recall: async () => 'remembered',
      remember: async () => undefined,
    };
    const wrapped = withMemory(mock, {
      scope: SCOPE,
      inject: (cfg, memory) => ({ ...cfg, perEventDelayMs: memory.length }),
    });
    const run = wrapped.adapter(happyConfig(), { memoryProvider: provider });
    await collect(run);
    await run.result;
    const calledWith = innerSpy.mock.calls[0]![0] as MockAgentConfig;
    expect(calledWith.perEventDelayMs).toBe('remembered'.length);
  });

  it('calls remember with captured events before result resolves', async () => {
    let rememberFinished = false;
    let resultFinished = false;
    const provider: MemoryProvider = {
      recall: async () => '',
      remember: async (scope, events) => {
        // Spend a microtask hop so we can detect ordering.
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        expect(events.length).toBeGreaterThan(0);
        rememberFinished = true;
      },
    };
    const mock = createMockAgent();
    const wrapped = withMemory(mock, { scope: SCOPE, inject: (c) => c });
    const run = wrapped.adapter(happyConfig(), { memoryProvider: provider });
    await collect(run);
    await run.result.then(() => {
      resultFinished = true;
    });
    expect(rememberFinished).toBe(true);
    expect(resultFinished).toBe(true);
  });

  it('captures the full event stream for remember()', async () => {
    let capturedTypes: string[] = [];
    const provider: MemoryProvider = {
      recall: async () => '',
      remember: async (_scope, events) => {
        capturedTypes = events.map((e) => e.type);
      },
    };
    const mock = createMockAgent();
    const wrapped = withMemory(mock, { scope: SCOPE, inject: (c) => c });
    const cfg: MockAgentConfig = {
      events: [
        { type: 'text', source: 'mock', delta: 'a' },
        { type: 'tool_call', source: 'mock', id: 't1', name: 'x', input: {} },
      ],
      result: {
        text: 'a',
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        executedToolCalls: [],
      } as AgentRunResult,
    };
    const run = wrapped.adapter(cfg, { memoryProvider: provider });
    await collect(run);
    await run.result;
    expect(capturedTypes).toContain('agent_start');
    expect(capturedTypes).toContain('text');
    expect(capturedTypes).toContain('tool_call');
    expect(capturedTypes).toContain('agent_end');
  });

  it('surfaces recall failure as a native event and continues with empty memory', async () => {
    let injectedMemory: string | null = null;
    const provider: MemoryProvider = {
      recall: async () => {
        throw new Error('recall broke');
      },
      remember: async () => undefined,
    };
    const bus = createEventBus();
    const seen: AgentEvent[] = [];
    bus.on((event) => seen.push(event));
    const mock = createMockAgent();
    const wrapped = withMemory(mock, {
      scope: SCOPE,
      inject: (cfg, memory) => {
        injectedMemory = memory;
        return cfg;
      },
    });
    const run = wrapped.adapter(happyConfig(), { memoryProvider: provider, eventBus: bus });
    await collect(run);
    const result = await run.result;
    expect(injectedMemory).toBe('');
    expect(result.finishReason).toBe('stop');
    expect(
      seen.some(
        (e) => e.type === 'native' && e.kind === 'memory:recall_failed',
      ),
    ).toBe(true);
  });

  it('surfaces remember failure as a native event but resolves the run cleanly', async () => {
    const provider: MemoryProvider = {
      recall: async () => '',
      remember: async () => {
        throw new Error('remember broke');
      },
    };
    const bus = createEventBus();
    const seen: AgentEvent[] = [];
    bus.on((event) => seen.push(event));
    const mock = createMockAgent();
    const wrapped = withMemory(mock, { scope: SCOPE, inject: (c) => c });
    const run = wrapped.adapter(happyConfig(), { memoryProvider: provider, eventBus: bus });
    await collect(run);
    const result = await run.result;
    expect(result.finishReason).toBe('stop');
    expect(
      seen.some(
        (e) => e.type === 'native' && e.kind === 'memory:remember_failed',
      ),
    ).toBe(true);
  });

  it('mirrors every event to the caller-supplied eventBus', async () => {
    const provider: MemoryProvider = {
      recall: async () => '',
      remember: async () => undefined,
    };
    const bus = createEventBus();
    const seen: AgentEvent[] = [];
    bus.on((event) => seen.push(event));
    const mock = createMockAgent();
    const wrapped = withMemory(mock, { scope: SCOPE, inject: (c) => c });
    const run = wrapped.adapter(happyConfig(), { memoryProvider: provider, eventBus: bus });
    const streamed = await collect(run);
    await run.result;
    expect(seen.length).toBeGreaterThanOrEqual(streamed.length);
  });

  it('honors pre-aborted signal — abort propagates to inner run', async () => {
    const provider: MemoryProvider = {
      recall: async () => '',
      remember: async () => undefined,
    };
    const controller = new AbortController();
    controller.abort();
    const mock = createMockAgent();
    const wrapped = withMemory(mock, { scope: SCOPE, inject: (c) => c });
    const run = wrapped.adapter(happyConfig(), {
      memoryProvider: provider,
      signal: controller.signal,
    });
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
  });

  it('throws when the events iterator is vended twice', async () => {
    const provider: MemoryProvider = {
      recall: async () => '',
      remember: async () => undefined,
    };
    const mock = createMockAgent();
    const wrapped = withMemory(mock, { scope: SCOPE, inject: (c) => c });
    const run = wrapped.adapter(happyConfig(), { memoryProvider: provider });
    run.events[Symbol.asyncIterator]();
    expect(() => run.events[Symbol.asyncIterator]()).toThrow();
    await run.result.catch(() => undefined);
  });
});
