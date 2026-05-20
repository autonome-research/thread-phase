/**
 * Integration tests — stitch together pieces that the unit tests cover
 * separately. Specifically the end-to-end paths the unit suite is missing:
 *
 *   - JobRunner.cancel propagating into a (mocked) agent loop's AbortSignal
 *   - parallelPhases with one branch erroring while another is mid-flight
 *   - SSE heartbeat under client disconnect mid-job
 *   - verifyResult hook seeing populated executedToolCalls
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { JobRunner } from '../src/session/job-runner.js';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import { streamToSSE, type SSEResponse } from '../src/session/sse.js';
import { PipelineCache } from '../src/cache.js';
import { runAgentWithTools } from '../src/agent/runner.js';
import { parallelPhases } from '../src/patterns/parallel-phases.js';
import type { Phase, BasePipelineContext } from '../src/phase.js';
import type { ToolExecutor, ToolResult } from '../src/messages.js';
import type { AgentRunnerOptions } from '../src/agent/types.js';

interface Ctx extends BasePipelineContext {
  output?: string;
  agentResult?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Mock OpenAI client that hangs on a stream until aborted, then throws.
// ---------------------------------------------------------------------------

function makeHangingClient(): any {
  return {
    chat: {
      completions: {
        create: async (_body: any, options: any) => {
          return {
            async *[Symbol.asyncIterator]() {
              // Stream content for a short while, observe abort, throw AbortError.
              let i = 0;
              while (i < 100) {
                if (options?.signal?.aborted) {
                  const err = new Error('aborted');
                  (err as any).name = 'AbortError';
                  throw err;
                }
                await sleep(10);
                yield {
                  id: 'c',
                  object: 'chat.completion.chunk',
                  created: 0,
                  model: 'm',
                  choices: [
                    { index: 0, delta: { content: 'tick ' }, finish_reason: null },
                  ],
                };
                i++;
              }
              // If we reach here, the test failed to abort us.
              yield {
                id: 'c',
                object: 'chat.completion.chunk',
                created: 0,
                model: 'm',
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              };
            },
          };
        },
      },
    },
  };
}

const noToolExecutor: ToolExecutor = {
  execute: async (): Promise<ToolResult> => ({ toolCallId: '', content: '' }),
};

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let dir: string;
let store: SqliteJobStore;
let runner: JobRunner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thread-phase-integ-'));
  store = new SqliteJobStore(join(dir, 'integ.db'));
  runner = new JobRunner(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// JobRunner.cancel → agent AbortSignal → AgentRunResult{finishReason:'error'}
// ---------------------------------------------------------------------------

describe('JobRunner.cancel propagates into runAgentWithTools', () => {
  it('aborts the inference stream when cancel() is called mid-job', async () => {
    let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
    let errorSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const client = makeHangingClient();

      const phase: Phase<Ctx> = {
        name: 'agent-phase',
        async *run(ctx) {
          yield { type: 'phase', phase: 'agent-phase', detail: 'starting' };
          const sig = runner.signalFor(jobId);
          const result = await runAgentWithTools(
            {
              name: 'hang-agent',
              systemPrompt: 's',
              model: 'm',
              tools: [],
              maxToolRounds: 1,
              maxTokens: 1000,
            },
            [{ role: 'user', content: 'go' }],
            { client, toolExecutor: noToolExecutor, signal: sig } as AgentRunnerOptions,
          );
          ctx.agentResult = result.finishReason;
          yield { type: 'data', key: 'finishReason', value: result.finishReason };
        },
      };

      const jobId = runner.create('cancel-into-agent', null);
      const ctx: Ctx = { cache: new PipelineCache() };
      const runPromise = runner.run(jobId, [phase], ctx);
      // Cancel after the stream has started but well before the 100-tick mock would finish.
      setTimeout(() => runner.cancel(jobId, 'user-stop'), 30);
      await runPromise;

      // The agent saw the signal and returned with finishReason=error.
      expect(ctx.agentResult).toBe('error');
      const job = store.getJob(jobId)!;
      expect(job.status).toBe('FAILED');
    } finally {
      warnSpy?.mockRestore();
      errorSpy?.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// parallelPhases interleaving with one erroring mid-flight
// ---------------------------------------------------------------------------

describe('parallelPhases — one branch errors mid-flight', () => {
  it('propagates the error after siblings have produced events', async () => {
    let sawSiblingEvent = false;

    const erroring: Phase<Ctx> = {
      name: 'err',
      async *run() {
        yield { type: 'phase', phase: 'err', detail: 'pre-error' };
        await sleep(30);
        throw new Error('mid-flight failure');
      },
    };

    const sibling: Phase<Ctx> = {
      name: 'sibling',
      async *run() {
        for (let i = 0; i < 5; i++) {
          await sleep(10);
          yield { type: 'phase', phase: 'sibling', detail: `tick ${i}` };
        }
      },
    };

    const consume = async () => {
      const ctx: Ctx = { cache: new PipelineCache() };
      for await (const ev of parallelPhases('p', [erroring, sibling]).run(ctx)) {
        if (ev.type === 'phase' && ev.phase === 'sibling') {
          sawSiblingEvent = true;
        }
      }
    };

    await expect(consume()).rejects.toThrow('mid-flight failure');
    expect(sawSiblingEvent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SSE heartbeat under client disconnect mid-job
// ---------------------------------------------------------------------------

describe('streamToSSE — client disconnect cleanup', () => {
  it('stops writing after the client closes the connection', async () => {
    class DisconnectingRes implements SSEResponse {
      chunks: string[] = [];
      closed = false;
      closeListeners: Array<() => void> = [];
      writeCount = 0;
      write(chunk: string): boolean {
        if (this.closed) return false;
        this.chunks.push(chunk);
        this.writeCount++;
        return true;
      }
      end(): void {
        if (this.closed) return;
        this.closed = true;
        for (const fn of this.closeListeners) fn();
      }
      on(_evt: 'close', listener: () => void): void {
        this.closeListeners.push(listener);
      }
      simulateClientDisconnect() {
        this.end();
      }
    }

    const phase: Phase<Ctx> = {
      name: 'long',
      async *run() {
        for (let i = 0; i < 20; i++) {
          await sleep(15);
          yield { type: 'phase', phase: 'long', detail: `tick ${i}` };
        }
      },
    };

    const jobId = runner.create('disconnect-test', null);
    const res = new DisconnectingRes();

    // Fire job + SSE concurrently; disconnect midway.
    const runPromise = runner.run(jobId, [phase], { cache: new PipelineCache() });
    const ssePromise = streamToSSE({ runner, store, jobId, res, heartbeatMs: 0 });

    setTimeout(() => res.simulateClientDisconnect(), 50);

    await ssePromise;
    const writesAtDisconnect = res.writeCount;
    await runPromise;

    // After the disconnect, no further writes should land.
    expect(res.writeCount).toBe(writesAtDisconnect);
    // Some writes happened before the disconnect.
    expect(writesAtDisconnect).toBeGreaterThan(0);
  });

  it('emits heartbeat comment lines on the configured interval', async () => {
    class FakeRes implements SSEResponse {
      chunks: string[] = [];
      closed = false;
      closeListeners: Array<() => void> = [];
      write(chunk: string): boolean {
        if (this.closed) return false;
        this.chunks.push(chunk);
        return true;
      }
      end(): void {
        if (this.closed) return;
        this.closed = true;
        for (const fn of this.closeListeners) fn();
      }
      on(_evt: 'close', listener: () => void): void {
        this.closeListeners.push(listener);
      }
    }

    const phase: Phase<Ctx> = {
      name: 'slow',
      async *run() {
        await sleep(120);
        yield { type: 'phase', phase: 'slow' };
      },
    };

    const jobId = runner.create('heartbeat', null);
    const res = new FakeRes();
    const runPromise = runner.run(jobId, [phase], { cache: new PipelineCache() });
    const ssePromise = streamToSSE({ runner, store, jobId, res, heartbeatMs: 30 });
    await Promise.all([runPromise, ssePromise]);

    // We expect at least 2 heartbeat lines (120ms / 30ms = 4 ticks roughly).
    const heartbeats = res.chunks.filter((c) => c.startsWith(': keepalive '));
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// verifyResult sees populated executedToolCalls (async hook variant)
// ---------------------------------------------------------------------------

describe('verifyResult — sees executedToolCalls', () => {
  // Reusable mock client builder for this section.
  const makeStreamClient = (chunks: any[]): any => ({
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield c;
          },
        }),
      },
    },
  });

  it('async verifyResult receives the executed tool calls and can transform the result', async () => {
    const tool = {
      name: 'do_thing',
      description: '',
      inputSchema: {
        type: 'object' as const,
        properties: { x: { type: 'number' } },
        required: ['x'],
        additionalProperties: false,
      },
    };

    const chunks = [
      // Round 1: assistant calls do_thing.
      [
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
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'do_thing', arguments: '{"x":42}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ],
      // Round 2: assistant returns final text.
      [
        {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'm',
          choices: [
            { index: 0, delta: { content: 'I called do_thing' }, finish_reason: 'stop' },
          ],
        },
      ],
    ];

    let i = 0;
    const client: any = {
      chat: {
        completions: {
          create: async () => makeStreamClient(chunks[i++]!).chat.completions.create(),
        },
      },
    };

    let seenCalls: number = -1;
    const result = await runAgentWithTools(
      {
        name: 'verifier-agent',
        systemPrompt: 's',
        model: 'm',
        tools: [tool],
        maxToolRounds: 5,
        maxTokens: 200,
      },
      [{ role: 'user', content: 'go' }],
      {
        client,
        toolExecutor: { execute: async (_n, id) => ({ toolCallId: id, content: 'ok' }) },
        verifyResult: async (r) => {
          await sleep(5); // confirm async hook works
          seenCalls = r.executedToolCalls.length;
          return { ...r, text: r.text + ' [verified]' };
        },
      } as AgentRunnerOptions,
    );

    expect(seenCalls).toBe(1);
    expect(result.text).toBe('I called do_thing [verified]');
    expect(result.executedToolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'do_thing',
      input: { x: 42 },
    });
  });
});
