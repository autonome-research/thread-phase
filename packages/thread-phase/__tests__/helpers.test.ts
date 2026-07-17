/**
 * Helpers — schedule / hook / oneShot convenience wrappers.
 *
 * Each helper returns an `ExtensionRegisterFn` `(api) => void` that adds a
 * trigger + pipeline (or just a pipeline, for oneShot) to a ThreadPhaseAPI.
 * Tests below use an in-memory mock of that API.
 */

import { describe, it, expect } from 'vitest';
import type {
  AgentAdapterMeta,
  AgentRunResult,
} from '../src/agents/index.js';
import type { BasePipelineContext, Phase, PipelineEvent } from '../src/phase.js';
import type { Trigger, TriggerEvent } from '../src/triggers/types.js';
import type { PipelineSpec, ThreadPhaseAPI } from '../src/helpers/types.js';
import { runPipeline } from '../src/orchestrator.js';
import { PipelineCache } from '../src/cache.js';

import { oneShot } from '../src/helpers/one-shot.js';
import { schedule, CronTrigger } from '../src/helpers/schedule.js';
import { hook, _resetHttpServerForTests } from '../src/helpers/hook.js';
import { TimerTrigger } from '../src/triggers/timer-trigger.js';

class MockAPI implements ThreadPhaseAPI {
  triggers = new Map<string, Trigger<unknown>>();
  adapters = new Map<string, AgentAdapterMeta<unknown, AgentRunResult>>();
  pipelines = new Map<string, PipelineSpec<BasePipelineContext, unknown>>();

  registerTrigger<TInput>(name: string, trigger: Trigger<TInput>): void {
    this.triggers.set(name, trigger as Trigger<unknown>);
  }
  registerAdapter<TConfig, TResult extends AgentRunResult = AgentRunResult>(
    name: string,
    adapter: AgentAdapterMeta<TConfig, TResult>,
  ): void {
    this.adapters.set(
      name,
      adapter as unknown as AgentAdapterMeta<unknown, AgentRunResult>,
    );
  }
  registerPipeline<TCtx extends BasePipelineContext, TInput = unknown>(
    name: string,
    spec: PipelineSpec<TCtx, TInput>,
  ): void {
    this.pipelines.set(
      name,
      spec as unknown as PipelineSpec<BasePipelineContext, unknown>,
    );
  }
  getTrigger(name: string): Trigger<unknown> | undefined {
    return this.triggers.get(name);
  }
  getAdapter(name: string): AgentAdapterMeta<unknown, AgentRunResult> | undefined {
    return this.adapters.get(name);
  }
  getPipeline(name: string): PipelineSpec<BasePipelineContext, unknown> | undefined {
    return this.pipelines.get(name);
  }
}

function materialize(
  spec: PipelineSpec<BasePipelineContext, unknown>,
  input?: unknown,
): { phases: ReadonlyArray<Phase<BasePipelineContext>>; ctx: BasePipelineContext } {
  const event = { id: 1, occurredAt: new Date().toISOString(), input };
  const phases =
    typeof spec.phases === 'function'
      ? spec.phases(input, event)
      : spec.phases;
  const ctxRaw =
    typeof spec.ctx === 'function'
      ? spec.ctx(input, event)
      : spec.ctx;
  const ctx: BasePipelineContext = ctxRaw.cache
    ? ctxRaw
    : { ...ctxRaw, cache: new PipelineCache() };
  return { phases, ctx };
}

describe('oneShot', () => {
  it('registers exactly one pipeline whose phase runs the handler', async () => {
    const api = new MockAPI();
    let called = false;
    const register = oneShot(async () => {
      called = true;
    });

    register(api);

    expect(api.pipelines.size).toBe(1);
    expect(api.triggers.size).toBe(0);

    const [, spec] = [...api.pipelines.entries()][0]!;
    const { phases, ctx } = materialize(spec);
    for await (const _ of runPipeline(phases, ctx)) void _;

    expect(called).toBe(true);
  });

  it('honours the optional name and description', () => {
    const api = new MockAPI();
    const register = oneShot(async () => 'ok', {
      name: 'nightly-cleanup',
      description: 'wipe scratch dir',
    });
    register(api);

    expect(api.pipelines.has('nightly-cleanup')).toBe(true);
    const spec = api.getPipeline('nightly-cleanup')!;
    expect(spec.description).toBe('wipe scratch dir');
    expect(spec.trigger).toBeUndefined();
  });

  it('forwards the dispatch input to the handler', async () => {
    const api = new MockAPI();
    let received: unknown = 'sentinel-never-set';
    const register = oneShot(
      async (input) => {
        received = input;
        return input;
      },
      { name: 'echo' },
    );
    register(api);

    const spec = api.getPipeline('echo')!;
    const { phases, ctx } = materialize(spec, { docsDir: 'case-docs', n: 7 });
    for await (const _ of runPipeline(phases, ctx)) void _;

    expect(received).toEqual({ docsDir: 'case-docs', n: 7 });
  });

  it('captures the handler return value as a data event', async () => {
    const api = new MockAPI();
    const register = oneShot(async () => ({ answer: 42 }), {
      name: 'demo',
    });
    register(api);

    const spec = api.getPipeline('demo')!;
    const { phases, ctx } = materialize(spec);
    const events: PipelineEvent[] = [];
    for await (const ev of runPipeline(phases, ctx)) events.push(ev);

    const dataEvent = events.find(
      (e) => e.type === 'data' && e.key === 'demo.result',
    );
    expect(dataEvent).toBeDefined();
    expect((dataEvent as { value: unknown }).value).toEqual({ answer: 42 });
  });
});

describe('schedule', () => {
  it('intervalMs form registers a TimerTrigger and a pipeline that binds to it', () => {
    const api = new MockAPI();
    const register = schedule({ intervalMs: 60_000 }, async () => undefined, {
      name: 'heartbeat',
    });
    register(api);

    expect(api.pipelines.size).toBe(1);
    expect(api.triggers.size).toBe(1);

    const spec = api.getPipeline('heartbeat')!;
    expect(spec.trigger).toBeDefined();

    const trigger = api.getTrigger(spec.trigger!);
    expect(trigger).toBeInstanceOf(TimerTrigger);
  });

  it('the registered pipeline invokes the handler and captures the result', async () => {
    const api = new MockAPI();
    const register = schedule({ intervalMs: 1_000 }, async () => 'tick', {
      name: 'pinger',
    });
    register(api);

    const spec = api.getPipeline('pinger')!;
    const { phases, ctx } = materialize(spec, undefined);
    const events: PipelineEvent[] = [];
    for await (const ev of runPipeline(phases, ctx)) events.push(ev);

    const data = events.find(
      (e) => e.type === 'data' && e.key === 'pinger.result',
    );
    expect(data).toBeDefined();
    expect((data as { value: unknown }).value).toBe('tick');
  });

  it('cron form registers a CronTrigger', () => {
    const api = new MockAPI();
    const register = schedule({ cron: '* * * * *' }, async () => 'ok', {
      name: 'cron-job',
    });
    register(api);

    const spec = api.getPipeline('cron-job')!;
    const trigger = api.getTrigger(spec.trigger!);
    expect(trigger).toBeInstanceOf(CronTrigger);
  });

  it('CronTrigger fires per the injected cron-parser schedule', async () => {
    // Mock cron-parser to always schedule "10ms from now".
    const mockParser = {
      parseExpression: (_expr: string) => ({
        next: () => ({ toDate: () => new Date(Date.now() + 10) }),
      }),
    };
    const trigger = new CronTrigger({
      cron: '* * * * *',
      name: 'test-cron',
      _cronParser: mockParser,
    });

    const events: TriggerEvent<void>[] = [];
    const gen = trigger.start();
    setTimeout(() => void trigger.stop(), 45);
    for await (const ev of gen) events.push(ev);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1));
  });
});

describe('hook', () => {
  it('registers a trigger and a pipeline bound to it', () => {
    _resetHttpServerForTests();
    const api = new MockAPI();
    const register = hook({ path: '/webhook/demo' }, async () => ({ ok: true }), {
      name: 'demo-hook',
    });
    register(api);

    expect(api.pipelines.size).toBe(1);
    expect(api.triggers.size).toBe(1);

    const spec = api.getPipeline('demo-hook')!;
    expect(spec.trigger).toBeDefined();
    expect(api.getTrigger(spec.trigger!)).toBeDefined();
  });

  it('multiple hooks share the same internal HTTP server (one trigger per route)', () => {
    _resetHttpServerForTests();
    const api = new MockAPI();
    hook({ path: '/a' }, async () => ({}), { name: 'h-a' })(api);
    hook({ path: '/b' }, async () => ({}), { name: 'h-b' })(api);

    expect(api.pipelines.size).toBe(2);
    expect(api.triggers.size).toBe(2);

    const trigA = api.getTrigger(api.getPipeline('h-a')!.trigger!) as {
      _server?: unknown;
    };
    const trigB = api.getTrigger(api.getPipeline('h-b')!.trigger!) as {
      _server?: unknown;
    };
    // Both triggers reference the same shared server instance.
    expect(trigA._server).toBeDefined();
    expect(trigA._server).toBe(trigB._server);
  });

  it('handler return value becomes the HTTP response body', async () => {
    _resetHttpServerForTests();
    process.env.THREAD_PHASE_HTTP_PORT = String(await freePort());

    const api = new MockAPI();
    hook({ path: '/echo' }, async (body: unknown) => ({ echoed: body }), {
      name: 'echo-hook',
    })(api);

    const trigger = api.getTrigger(api.getPipeline('echo-hook')!.trigger!)!;
    const spec = api.getPipeline('echo-hook')!;

    // Spin a tiny consumer loop that materializes + runs the pipeline per event.
    const stopFlag = { stopped: false };
    const consumer = (async () => {
      for await (const event of trigger.start()) {
        if (stopFlag.stopped) break;
        const { phases, ctx } = materialize(spec, event.input);
        // Inject the event into the ctx so the phase can settle the HTTP response.
        (ctx as { __triggerEvent?: TriggerEvent<unknown> }).__triggerEvent = event;
        for await (const _ of runPipeline(phases, ctx)) void _;
      }
    })();

    const port = Number(process.env.THREAD_PHASE_HTTP_PORT);
    const response = await postJson(`http://127.0.0.1:${port}/echo`, {
      hi: 'there',
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ echoed: { hi: 'there' } });

    stopFlag.stopped = true;
    await trigger.stop();
    await consumer.catch(() => undefined);
  });

  it('handler errors produce HTTP 500', async () => {
    _resetHttpServerForTests();
    process.env.THREAD_PHASE_HTTP_PORT = String(await freePort());

    const api = new MockAPI();
    hook(
      { path: '/boom' },
      async () => {
        throw new Error('kaboom');
      },
      { name: 'boom-hook' },
    )(api);

    const trigger = api.getTrigger(api.getPipeline('boom-hook')!.trigger!)!;
    const spec = api.getPipeline('boom-hook')!;
    const stopFlag = { stopped: false };
    const consumer = (async () => {
      for await (const event of trigger.start()) {
        if (stopFlag.stopped) break;
        const { phases, ctx } = materialize(spec, event.input);
        (ctx as { __triggerEvent?: TriggerEvent<unknown> }).__triggerEvent = event;
        try {
          for await (const _ of runPipeline(phases, ctx)) void _;
        } catch {
          // expected
        }
      }
    })();

    const port = Number(process.env.THREAD_PHASE_HTTP_PORT);
    const response = await postJson(`http://127.0.0.1:${port}/boom`, {});
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'kaboom' });

    stopFlag.stopped = true;
    await trigger.stop();
    await consumer.catch(() => undefined);
  });
});

// -- HTTP test helpers ------------------------------------------------------

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}
