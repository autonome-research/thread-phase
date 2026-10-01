import { describe, expect, it, vi } from 'vitest';
import {
  APIUserAbortError, APITimeoutError, AuthenticationError, TypeSafeClient,
  choice, noul, score, type Fetch, type SystemOneResult,
} from '@typesafe-ai/sdk';
import { PipelineCache } from '../src/cache.js';
import { runPipeline } from '../src/orchestrator.js';
import { match } from '../src/patterns/match.js';
import type { BasePipelineContext, PipelineEvent } from '../src/phase.js';
import { JobRunner } from '../src/session/job-runner.js';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import { systemOne } from '../src/typesafe.js';

const questions = {
  department: choice('Which team?', { billing: null, technical: null }),
  urgency: noul('Is this urgent?'),
  severity: score('How severe?', ['Low', 'High']),
};
const response: SystemOneResult<typeof questions> = {
  model: 'jev-test',
  answers: {
    department: { type: 'choice', choice: 'billing', confidence: 0.8,
      probabilities: { billing: 0.9, technical: 0.1 } },
    urgency: { type: 'noul', noul: 0.95 },
    severity: { type: 'score', score: 0.9, confidence: 0.8,
      legend: { 0: 'Low', 1: 'High' }, probabilities: { 0: 0.1, 1: 0.9 } },
  },
  usage: { input_tokens: 42, output_tokens: 12 },
};
interface Ctx extends BasePipelineContext {
  ticket: string;
  result?: typeof response;
  routed?: string;
}
const makeCtx = (): Ctx => ({ cache: new PipelineCache(), ticket: 'private ticket text' });
const clientWith = (fetch: Fetch) => new TypeSafeClient({
  apiKey: 'test-secret', logLevel: 'off', retry: { maxRetries: 0 }, fetch,
});
const request = (ctx: Ctx) => ({ state: { ticket: ctx.ticket }, questions, model: 'jev-test' });
async function collect(events: AsyncIterable<PipelineEvent>, into: PipelineEvent[] = []) {
  for await (const event of events) into.push(event);
  return into;
}

// The real SDK transport waits until aborted: no API key or live network needed.
function pendingTransport() {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const fetch = vi.fn<Fetch>((_url, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started();
  }));
  return { fetch, ready };
}

describe('systemOne', () => {
  it('preserves all answer types, authenticates, emits results, and composes with match', async () => {
    const fetch = vi.fn<Fetch>(async () => Response.json(response));
    const phase = systemOne('evaluate', {
      client: clientWith(fetch), request,
      requestOptions: { timeout: 2000, headers: { 'x-test': 'phase' } },
      onResult: async (result, ctx) => { ctx.result = result; },
    });
    const route = match<Ctx, 'billing' | 'technical'>('route', {
      selector: (ctx) => ctx.result!.answers.department.choice,
      cases: {
        billing: [{ name: 'billing', async *run(ctx) { ctx.routed = 'billing'; } }],
        technical: [],
      },
    });
    const ctx = makeCtx();
    const events = await collect(runPipeline([phase, route], ctx));
    expect(ctx.result).toEqual(response);
    expect(ctx.routed).toBe('billing');
    expect(events).toContainEqual({ type: 'data', key: 'evaluate.result', value: response });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init!.method).toBe('POST');
    expect(new Headers(init!.headers).get('authorization')).toBe('Bearer test-secret');
    expect(new Headers(init!.headers).get('x-test')).toBe('phase');
    expect(JSON.parse(init!.body as string)).toEqual(request(ctx));
    expect(JSON.stringify({ phase, events, ctx })).not.toContain('test-secret');
    expect(JSON.stringify(events)).not.toContain(ctx.ticket);
    expect(JSON.stringify(events)).not.toContain('Which team?');
  });

  it('allows onResult to stop downstream work', async () => {
    const phase = systemOne('gate', {
      client: clientWith(async () => Response.json(response)), request,
      onResult: (_result, ctx) => { ctx.stop = { reason: 'human review' }; },
    });
    const events = await collect(runPipeline([phase, {
      name: 'unreachable', async *run() { throw new Error('must not run'); },
    }], makeCtx()));
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'human review' });
  });

  it('propagates SDK authentication errors without a result event or callback', async () => {
    const onResult = vi.fn();
    const phase = systemOne('evaluate', {
      client: clientWith(async () => Response.json({ detail: 'invalid key' }, { status: 401 })),
      request, onResult,
    });
    const events: PipelineEvent[] = [];
    await expect(collect(runPipeline([phase], makeCtx()), events)).rejects.toBeInstanceOf(AuthenticationError);
    expect(onResult).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['phase']);
  });

  it('leaves retries to the SDK and honors request overrides', async () => {
    const fetch = vi.fn<Fetch>()
      .mockResolvedValueOnce(Response.json({ detail: 'busy' }, { status: 529 }))
      .mockImplementationOnce(async () => Response.json(response));
    const phase = systemOne('evaluate', {
      client: clientWith(fetch), request, onResult: () => {},
      requestOptions: { retry: { maxRetries: 1, backoffInitialMs: 0, backoffJitter: 0 } },
    });
    await collect(phase.run(makeCtx()));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('honors the SDK timeout without writing a result', async () => {
    const { fetch } = pendingTransport();
    const onResult = vi.fn();
    const phase = systemOne('evaluate', {
      client: clientWith(fetch), request, onResult, requestOptions: { timeout: 20 },
    });
    await expect(collect(phase.run(makeCtx()))).rejects.toBeInstanceOf(APITimeoutError);
    expect(onResult).not.toHaveBeenCalled();
  });

  it('rejects pre-aborted calls and cancellation during request preparation before transport', async () => {
    const fetch = vi.fn<Fetch>();
    const controller = new AbortController();
    const onResult = vi.fn();
    const prepare = vi.fn(request);
    const phase = systemOne('evaluate', { client: clientWith(fetch), request: prepare, onResult });
    controller.abort();
    await expect(collect(phase.run({ ...makeCtx(), signal: controller.signal }))).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();

    const second = new AbortController();
    const preparing = systemOne('evaluate', {
      client: clientWith(fetch), onResult,
      request: async (ctx: Ctx) => { second.abort(); return request(ctx); },
    });
    await expect(collect(preparing.run({ ...makeCtx(), signal: second.signal }))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('propagates onResult failure without emitting a successful result', async () => {
    const failure = new Error('cannot save result');
    const phase = systemOne('evaluate', {
      client: clientWith(async () => Response.json(response)), request,
      onResult: async () => { throw failure; },
    });
    const events: PipelineEvent[] = [];
    await expect(collect(phase.run(makeCtx()), events)).rejects.toBe(failure);
    expect(events.map((event) => event.type)).toEqual(['phase']);
  });

  it('forwards in-flight pipeline cancellation to the SDK', async () => {
    const { fetch, ready } = pendingTransport();
    const controller = new AbortController();
    const onResult = vi.fn();
    const phase = systemOne('evaluate', { client: clientWith(fetch), request, onResult });
    const run = collect(runPipeline([phase], makeCtx(), { signal: controller.signal }));
    const rejected = expect(run).rejects.toBeInstanceOf(APIUserAbortError);
    await ready;
    controller.abort();
    await rejected;
    expect(onResult).not.toHaveBeenCalled();
  });

  it('propagates JobRunner cancellation through the SDK and persists CANCELLED, not success', async () => {
    const { fetch, ready } = pendingTransport();
    const onResult = vi.fn();
    const store = new SqliteJobStore(':memory:');
    try {
      const runner = new JobRunner(store);
      const id = await runner.create('typesafe', null);
      const phase = systemOne('evaluate', { client: clientWith(fetch), request, onResult });
      const run = runner.run(id, [phase], makeCtx());
      const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
      await ready;
      await runner.cancel(id, 'test cancellation');
      await rejected;
      expect(onResult).not.toHaveBeenCalled();
      expect((await store.getJob(id))?.status).toBe('CANCELLED');
      const types = (await store.getEvents(id)).map((event) => event.eventType);
      expect(types).toContain('cancelled');
      expect(types).not.toContain('data');
      expect(types).not.toContain('done');
    } finally {
      store.close();
    }
  });
});
