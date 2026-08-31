import { describe, expect, it } from 'vitest';

import { runAdapterConformance } from '@autonome-research/thread-phase/agents/test-utils';
import type { AgentEvent } from '@autonome-research/thread-phase/agents';

import {
  grokBotAgent,
  type GrokBotAgentConfig,
  type GrokBotInvokeClient,
  type GrokBotInvokeEvent,
} from '../src/grok-bot/index.js';

const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };

function clientFor(events: GrokBotInvokeEvent[]): GrokBotInvokeClient {
  return {
    async startRun() {
      return {
        runId: 'run-1',
        resumeToken: 'conversation-1',
        events: (async function* () {
          for (const event of events) yield event;
        })(),
        cancel() {},
      };
    },
  };
}

function buildConfig(client: GrokBotInvokeClient = clientFor([
  { type: 'message', text: 'Hello from Grok Bot.', usage },
  { type: 'completed', resumeToken: 'conversation-1', usage },
])): GrokBotAgentConfig {
  return {
    agentId: 'agent-123',
    prompt: 'hello',
    resumeToken: 'conversation-input',
    client,
  };
}

async function collect(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

describe('grokBotAgent', () => {
  it('maps invoke events into the canonical vocabulary', async () => {
    const client = clientFor([
      { type: 'run_accepted', runId: 'run-1', resumeToken: 'conversation-2' },
      { type: 'thinking', text: 'visible product reasoning' },
      { type: 'tool_call', id: 'tool-1', name: 'browser', input: { url: 'https://example.com' } },
      { type: 'tool_result', id: 'tool-1', name: 'browser', output: 'ok' },
      { type: 'message', text: 'Done.', usage },
      { type: 'human_gate', payload: { kind: 'desktop_sign_in' } },
      { type: 'completed', resumeToken: 'conversation-2', usage },
    ]);

    const run = grokBotAgent.adapter(buildConfig(client), { traceId: 'job-1' });
    const [events, result] = await Promise.all([collect(run), run.result]);

    expect(events[0]).toMatchObject({ type: 'agent_start', source: 'grok-bot', traceId: 'job-1' });
    expect(events.at(-1)).toMatchObject({
      type: 'agent_end',
      source: 'grok-bot',
      reason: 'stop',
      resumeToken: { kind: 'opaque', data: 'conversation-2' },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'thinking', delta: 'visible product reasoning' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call', id: 'tool-1', name: 'browser' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', id: 'tool-1', isError: false }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'native', kind: 'grok-bot:run_accepted' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'native', kind: 'human_gate' }));
    expect(result).toMatchObject({
      text: 'Done.',
      finishReason: 'stop',
      usage,
      resumeToken: { kind: 'opaque', data: 'conversation-2' },
    });
    expect(result.executedToolCalls).toEqual([
      { id: 'tool-1', name: 'browser', input: { url: 'https://example.com' } },
    ]);
  });

  it('closes the remote iterator after a completed event', async () => {
    let finalized = false;
    const never = new Promise<void>(() => undefined);
    const client: GrokBotInvokeClient = {
      async startRun() {
        return {
          runId: 'run-finalize',
          events: (async function* () {
            try {
              yield { type: 'completed' } as const;
              await never;
            } finally {
              finalized = true;
            }
          })(),
          cancel() {},
        };
      },
    };

    const result = await grokBotAgent.adapter(buildConfig(client)).result;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.finishReason).toBe('stop');
    expect(finalized).toBe(true);
  });

  it('keeps iterator cleanup failures from overwriting completion', async () => {
    let delivered = false;
    const client: GrokBotInvokeClient = {
      async startRun() {
        return {
          runId: 'run-cleanup-error',
          events: {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  if (delivered) return new Promise(() => undefined);
                  delivered = true;
                  return { done: false, value: { type: 'completed' } as const };
                },
                async return() {
                  throw new Error('cleanup failed');
                },
              };
            },
          },
          cancel() {},
        };
      },
    };

    await expect(grokBotAgent.adapter(buildConfig(client)).result).resolves.toMatchObject({
      finishReason: 'stop',
    });
  });

  it('does not share mutable zero-usage state across runs', async () => {
    const first = await grokBotAgent.adapter(buildConfig(clientFor([
      { type: 'completed' },
    ]))).result;
    first.usage.totalTokens = 99;
    const second = await grokBotAgent.adapter(buildConfig(clientFor([
      { type: 'completed' },
    ]))).result;

    expect(second.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  it('keeps cumulative product usage off individual turn_end events', async () => {
    const first = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };
    const second = { promptTokens: 4, completionTokens: 5, totalTokens: 9 };
    const run = grokBotAgent.adapter(buildConfig(clientFor([
      { type: 'message', text: 'First.', usage: first },
      { type: 'message', text: 'Second.', usage: second },
      { type: 'completed', usage: second },
    ])));
    const [events, result] = await Promise.all([collect(run), run.result]);
    const turns = events.filter((event) => event.type === 'turn_end');

    expect(turns).toHaveLength(2);
    expect(turns.every((event) => event.usage === undefined)).toBe(true);
    expect(result.usage).toEqual(second);
  });

  it('normalizes structured-output prompt construction failures', async () => {
    const schema: Record<string, unknown> = {};
    schema.self = schema;
    const run = grokBotAgent.adapter({
      ...buildConfig(),
      outputSchema: { schema },
    });
    const [events, result] = await Promise.all([collect(run), run.result]);

    expect(result.finishReason).toBe('error');
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'error' });
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });

  it('records parseError for truncated structured output', async () => {
    const run = grokBotAgent.adapter({
      ...buildConfig(clientFor([
        { type: 'message', text: '<response>{"ok":' },
        { type: 'completed', finishReason: 'length' },
      ])),
      outputSchema: { schema: { type: 'object' } },
    });
    const result = await run.result;

    expect(result.finishReason).toBe('length');
    expect(result.parsed).toBeUndefined();
    expect(result.parseError).toBeDefined();
  });

  it('preserves transient errors and resolves with an error result', async () => {
    const run = grokBotAgent.adapter(buildConfig(clientFor([
      { type: 'error', error: new Error('rate limited'), transient: true },
    ])));
    const [events, result] = await Promise.all([collect(run), run.result]);

    expect(events).toContainEqual(expect.objectContaining({ type: 'error', transient: true }));
    expect(result.finishReason).toBe('error');
  });

  it('synthesizes a diagnostic when completion reports an error without one', async () => {
    const run = grokBotAgent.adapter(buildConfig(clientFor([
      { type: 'completed', finishReason: 'error' },
    ])));
    const [events, result] = await Promise.all([collect(run), run.result]);
    const errorIndex = events.findIndex((event) => event.type === 'error');
    const endIndex = events.findIndex((event) => event.type === 'agent_end');

    expect(result.finishReason).toBe('error');
    expect(errorIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeLessThan(endIndex);
  });

  it('cancels an in-flight remote turn and keeps abort idempotent', async () => {
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { releaseStart = resolve; });
    let releaseEvents!: () => void;
    const eventsReleased = new Promise<void>((resolve) => { releaseEvents = resolve; });
    let cancelCalls = 0;

    const client: GrokBotInvokeClient = {
      async startRun() {
        return {
          runId: 'run-cancel',
          events: (async function* () {
            yield { type: 'run_accepted', runId: 'run-cancel' } as const;
            releaseStart();
            await eventsReleased;
          })(),
          cancel() {
            cancelCalls += 1;
            releaseEvents();
          },
        };
      },
    };

    const run = grokBotAgent.adapter(buildConfig(client));
    const resultPromise = run.result;
    await started;
    run.abort('user cancelled');
    run.abort('duplicate');
    const result = await resultPromise;

    expect(result.finishReason).toBe('aborted');
    expect(cancelCalls).toBe(1);
  });

  it('uses timeoutMs as a wall-clock bound when the event stream ignores abort', async () => {
    const never = new Promise<void>(() => undefined);
    let cancelled = false;
    const client: GrokBotInvokeClient = {
      async startRun() {
        return {
          runId: 'run-timeout',
          events: (async function* () {
            await never;
          })(),
          cancel() {
            cancelled = true;
          },
        };
      },
    };

    const result = await grokBotAgent.adapter({
      ...buildConfig(client),
      timeoutMs: 10,
    }).result;

    expect(result.finishReason).toBe('aborted');
    expect(cancelled).toBe(true);
  });

  it('uses timeoutMs as a wall-clock bound when startRun ignores abort', async () => {
    const client: GrokBotInvokeClient = {
      startRun: () => new Promise(() => undefined),
    };

    const result = await grokBotAgent.adapter({
      ...buildConfig(client),
      timeoutMs: 10,
    }).result;

    expect(result.finishReason).toBe('aborted');
  });

  it('cancels a delayed remote run that is accepted after local abort', async () => {
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { releaseStart = resolve; });
    let resolveRemote!: (run: Awaited<ReturnType<GrokBotInvokeClient['startRun']>>) => void;
    const remote = new Promise<Awaited<ReturnType<GrokBotInvokeClient['startRun']>>>(
      (resolve) => { resolveRemote = resolve; },
    );
    let cancelCalls = 0;
    const client: GrokBotInvokeClient = {
      startRun() {
        releaseStart();
        return remote;
      },
    };

    const run = grokBotAgent.adapter(buildConfig(client));
    const resultPromise = run.result;
    await started;
    run.abort('user cancelled');
    await expect(resultPromise).resolves.toMatchObject({ finishReason: 'aborted' });

    resolveRemote({
      runId: 'run-late',
      events: (async function* () {})(),
      cancel() { cancelCalls += 1; },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelCalls).toBe(1);
  });

  it.each([
    ['synchronous throw', () => { throw new Error('cancel failed'); }],
    ['asynchronous rejection', async () => { throw new Error('cancel failed'); }],
  ])('contains a %s from remote cancel', async (_label, cancel) => {
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { releaseStart = resolve; });
    const never = new Promise<void>(() => undefined);
    const client: GrokBotInvokeClient = {
      async startRun() {
        return {
          runId: 'run-cancel-error',
          events: (async function* () {
            releaseStart();
            await never;
          })(),
          cancel,
        };
      },
    };

    const run = grokBotAgent.adapter(buildConfig(client));
    const resultPromise = run.result;
    await started;
    run.abort('user cancelled');

    await expect(resultPromise).resolves.toMatchObject({ finishReason: 'aborted' });
  });

  it('rejects timeoutMs values that exceed Node timer limits', async () => {
    const result = await grokBotAgent.adapter({
      ...buildConfig(),
      timeoutMs: 2_147_483_648,
    }).result;

    expect(result.finishReason).toBe('error');
  });

  it('reports a clear error when no product invoke client is available', async () => {
    const config = { agentId: 'agent-123', prompt: 'hello' } as GrokBotAgentConfig;
    const run = grokBotAgent.adapter(config);
    const [events, result] = await Promise.all([collect(run), run.result]);
    const error = events.find((event) => event.type === 'error');

    expect(result.finishReason).toBe('error');
    expect(error && error.type === 'error' ? error.error.message : '').toContain(
      'requires an authenticated GrokBotInvokeClient',
    );
  });

  it('declares honest product capabilities', () => {
    expect(grokBotAgent.id).toBe('grok-bot');
    expect(grokBotAgent.capabilities).toEqual({
      streaming: 'turns',
      cancellation: 'cooperative',
      resumption: 'opaque',
      structuredOutput: 'prompted',
    });
  });
});

describe('grokBotAgent — conformance', () => {
  runAdapterConformance({
    meta: grokBotAgent,
    buildConfig,
    buildErrorConfig: () => buildConfig({
      async startRun() {
        throw Object.assign(new Error('invoke service unavailable'), { status: 503 });
      },
    }),
  });
});
