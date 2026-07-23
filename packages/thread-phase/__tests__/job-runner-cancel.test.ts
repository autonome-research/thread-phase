/**
 * JobRunner cancellation: a long-running phase that observes the runner's
 * abort signal must unwind cleanly when cancel() is called, marking the job
 * CANCELLED with request and terminal events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JobRunner } from '../src/session/job-runner.js';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import { PipelineCache } from '../src/cache.js';
import type { Phase, BasePipelineContext } from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  agentSignal?: AbortSignal;
  result?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let dir: string;
let store: SqliteJobStore;
let runner: JobRunner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thread-phase-cancel-'));
  store = new SqliteJobStore(join(dir, 'cancel.db'));
  runner = new JobRunner(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('JobRunner.run summary', () => {
  it('returns a completed PipelineSummary on success', async () => {
    const phase: Phase<Ctx> = {
      name: 'work',
      async *run() {
        yield { type: 'phase', phase: 'work' };
      },
    };
    const jobId = await runner.create('test', null);
    const summary = await runner.run(jobId, [phase], { cache: new PipelineCache() });
    expect(summary).toEqual({ status: 'completed', eventCount: 2 });
  });

  it('finalResult failure persists only error, never a premature done event', async () => {
    const phase: Phase<Ctx> = {
      name: 'work',
      async *run() { yield { type: 'phase', phase: 'work' }; },
    };
    const jobId = await runner.create('final-result-failure', null);
    await expect(
      runner.run(jobId, [phase], { cache: new PipelineCache() }, () => {
        throw new Error('result serialization failed');
      }),
    ).rejects.toThrow('result serialization failed');
    const events = await store.getEvents(jobId);
    expect(events.filter((event) => ['done', 'error', 'cancelled'].includes(event.eventType)).map((event) => event.eventType)).toEqual(['error']);
    expect((await store.getJob(jobId))?.status).toBe('FAILED');
  });

  it('falls back to FAILED when successful completion persistence rejects', async () => {
    const completionFailure = new Error('completion write failed');
    const finalizeJob = store.finalizeJob.bind(store);
    store.finalizeJob = async (jobId, finalization) => {
      if (finalization.status === 'COMPLETED') throw completionFailure;
      return finalizeJob(jobId, finalization);
    };
    const phase: Phase<Ctx> = {
      name: 'work',
      async *run() { yield { type: 'phase', phase: 'work' }; },
    };
    const jobId = await runner.create('completion-persistence-failure', null);

    await expect(
      runner.run(jobId, [phase], { cache: new PipelineCache() }),
    ).rejects.toBe(completionFailure);
    expect(await store.getJob(jobId)).toMatchObject({
      status: 'FAILED',
      error: 'completion write failed',
    });
    expect((await store.getEvents(jobId)).at(-1)?.eventType).toBe('error');
  });

  it('rejects with the phase error, marks job FAILED, writes a synthesized error event', async () => {
    const phase: Phase<Ctx> = {
      name: 'boom',
      async *run() {
        yield { type: 'phase', phase: 'boom' };
        throw new Error('explicit boom');
      },
    };
    const jobId = await runner.create('failing', null);
    await expect(
      runner.run(jobId, [phase], { cache: new PipelineCache() }),
    ).rejects.toThrow(/explicit boom/);

    const job = (await store.getJob(jobId))!;
    expect(job.status).toBe('FAILED');
    expect(job.error).toBe('explicit boom');

    const events = await store.getEvents(jobId);
    const lastEvent = events.at(-1)!;
    expect(lastEvent.eventType).toBe('error');
  });
});

describe('JobRunner.cancel', () => {
  it('signalFor returns undefined for unknown jobs', () => {
    expect(runner.signalFor('nope')).toBeUndefined();
  });

  it('exposes a signal during run and clears it after', async () => {
    const seenSignal: { value?: AbortSignal } = {};
    const phase: Phase<Ctx> = {
      name: 'p',
      async *run(ctx) {
        seenSignal.value = runner.signalFor(jobId);
        yield { type: 'phase', phase: 'p' };
        ctx.result = 'ok';
      },
    };
    const jobId = await runner.create('test', null);
    await runner.run(jobId, [phase], { cache: new PipelineCache() });
    expect(seenSignal.value).toBeDefined();
    // Cleared after run finishes.
    expect(runner.signalFor(jobId)).toBeUndefined();
  });

  it('cancel() aborts the in-flight pipeline and marks job CANCELLED', async () => {
    const phase: Phase<Ctx> = {
      name: 'long',
      async *run() {
        // Loop yielding events; each loop checks the signal so the pipeline
        // can unwind cleanly.
        for (let i = 0; i < 50; i++) {
          await sleep(10);
          yield { type: 'phase', phase: 'long', detail: `tick ${i}` };
        }
      },
    };
    const jobId = await runner.create('cancel-test', null);
    const runPromise = runner.run(jobId, [phase], { cache: new PipelineCache() });
    // Cancel after a few ticks.
    setTimeout(() => runner.cancel(jobId, 'user-stop'), 30);
    await expect(runPromise).rejects.toMatchObject({
      name: 'AbortError',
      message: /cancelled.*user-stop/,
    });
    const job = (await store.getJob(jobId))!;
    expect(job.status).toBe('CANCELLED');
    expect(job.error).toBe('user-stop');
    const events = await store.getEvents(jobId);
    expect(events.map((event) => event.eventType)).toContain('cancellation_requested');
    expect(events.map((event) => event.eventType)).toContain('cancelled');
    expect(events.map((event) => event.eventType)).not.toContain('error');
  });

  it('finalizes cancellation and surfaces cancellation-request persistence failure', async () => {
    const requestFailure = new Error('request audit write failed');
    const appendEvent = store.appendEvent.bind(store);
    store.appendEvent = async (jobId, event) => {
      if (event.type === 'cancellation_requested') throw requestFailure;
      return appendEvent(jobId, event);
    };
    const jobId = await runner.create('cancel-request-failure', null);
    const phase: Phase<Ctx> = {
      name: 'cooperative',
      async *run(ctx) {
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };

    const running = runner.run(jobId, [phase], { cache: new PipelineCache() });
    setTimeout(() => runner.cancel(jobId, 'audit failure cancellation'), 10);
    const rejection = await running.catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect(rejection).toMatchObject({ name: 'AbortError' });
    expect((rejection as AggregateError).errors).toContain(requestFailure);
    expect((await store.getJob(jobId))?.status).toBe('CANCELLED');
    expect((await store.getEvents(jobId)).map((event) => event.eventType)).toEqual(['cancelled']);
  });

  it('orders pre-aborted caller cancellation as request then atomic terminal cancellation', async () => {
    const upstream = new AbortController();
    upstream.abort('already stopped');
    const jobId = await runner.create('pre-aborted', null);
    await expect(
      runner.run(jobId, [{ name: 'never', async *run() { yield { type: 'phase', phase: 'never' }; } }], {
        cache: new PipelineCache(),
        signal: upstream.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const events = await store.getEvents(jobId);
    expect(events.map((event) => event.eventType)).toEqual(['cancellation_requested', 'cancelled']);
    expect((await store.getJob(jobId))?.status).toBe('CANCELLED');
  });

  it('never emits done when an aborted phase unwinds cleanly', async () => {
    const jobId = await runner.create('clean-unwind', null);
    const phase: Phase<Ctx> = {
      name: 'cooperative',
      async *run(ctx) {
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    const running = runner.run(jobId, [phase], { cache: new PipelineCache() });
    setTimeout(() => runner.cancel(jobId, 'clean stop'), 10);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    const terminal = (await store.getEvents(jobId)).filter((event) => ['done', 'error', 'cancelled'].includes(event.eventType));
    expect(terminal.map((event) => event.eventType)).toEqual(['cancelled']);
  });

  it('never appends cancellation events when its ownership claim loses', async () => {
    const jobId = await runner.create('owned-elsewhere', null);
    await store.setRunning(jobId, { ownerId: 'winner' });
    const loser = new JobRunner(store);
    const handle = loser.start(
      jobId,
      [{ name: 'never', async *run() { yield { type: 'phase', phase: 'never' }; } }],
      { cache: new PipelineCache() },
      undefined,
      { ownership: { ownerId: 'loser' } },
    );
    handle.cancel('should not pollute');
    await expect(handle.result).rejects.toThrow(/already owned/);
    expect(await store.getEvents(jobId)).toEqual([]);
    expect((await store.getJob(jobId))?.ownerId).toBe('winner');
  });

  it('cancel() is a no-op for jobs that are not running', () => {
    expect(() => runner.cancel('nonexistent', 'whatever')).not.toThrow();
  });

  it('signal is forwarded into a phase that wires it into runAgentWithTools', async () => {
    let capturedSignal: AbortSignal | undefined;
    const phase: Phase<Ctx> = {
      name: 'wired',
      async *run() {
        const sig = runner.signalFor(jobId)!;
        capturedSignal = sig;
        // Simulate phase code that observes the signal.
        await new Promise<void>((resolve, reject) => {
          if (sig.aborted) return reject(new Error('aborted'));
          sig.addEventListener('abort', () => reject(new Error('aborted')));
          setTimeout(resolve, 200);
        });
        yield { type: 'phase', phase: 'wired' };
      },
    };
    const jobId = await runner.create('wired', null);
    const p = runner.run(jobId, [phase], { cache: new PipelineCache() });
    setTimeout(() => runner.cancel(jobId, 'wired-cancel'), 20);
    // A phase may reject with its own error while unwinding, but the runner's
    // aborted signal remains authoritative for lifecycle classification.
    await expect(p).rejects.toMatchObject({ name: 'AbortError', message: /wired-cancel/ });
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
    const job = (await store.getJob(jobId))!;
    expect(job.status).toBe('CANCELLED');
  });

  it('automatically installs the runner signal on ctx and restores it afterward', async () => {
    const upstream = new AbortController();
    const ctx: Ctx = { cache: new PipelineCache(), signal: upstream.signal };
    let phaseSignal: AbortSignal | undefined;
    const phase: Phase<Ctx> = {
      name: 'observe',
      async *run(runCtx) {
        phaseSignal = runCtx.signal;
        yield { type: 'phase', phase: 'observe' };
      },
    };
    const jobId = await runner.create('signal-compose', null);
    await runner.run(jobId, [phase], ctx);
    expect(phaseSignal).toBeDefined();
    expect(phaseSignal).not.toBe(upstream.signal);
    expect(ctx.signal).toBe(upstream.signal);
  });

  it('rejects concurrent runs that share one mutable pipeline context', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const phase: Phase<Ctx> = {
      name: 'wait',
      async *run() {
        await gate;
        yield { type: 'phase', phase: 'wait' };
      },
    };
    const ctx: Ctx = { cache: new PipelineCache() };
    const firstId = await runner.create('first', null);
    const secondId = await runner.create('second', null);
    const first = runner.run(firstId, [phase], ctx);
    await expect(runner.run(secondId, [phase], ctx)).rejects.toThrow(/same pipeline context/);
    release();
    await first;
  });

  it('keeps handle cancellation authoritative when finalResult requests it', async () => {
    const phase: Phase<Ctx> = {
      name: 'work',
      async *run() {
        yield { type: 'phase', phase: 'work' };
      },
    };
    const jobId = await runner.create('cancel-in-final-result', null);
    let handle!: { cancel(reason?: string): void };
    handle = runner.start(
      jobId,
      [phase],
      { cache: new PipelineCache() },
      () => {
        handle.cancel('final-result-cancel');
        return 'must-not-complete';
      },
    );

    await expect(handle.result).rejects.toMatchObject({
      name: 'AbortError',
      message: /final-result-cancel/,
    });
    expect((await store.getJob(jobId))?.status).toBe('CANCELLED');
    expect((await store.getEvents(jobId)).map((record) => record.eventType)).toEqual([
      'phase',
      'cancellation_requested',
      'cancelled',
    ]);
  });

  it('keeps caller-signal cancellation authoritative when finalResult aborts it', async () => {
    const upstream = new AbortController();
    const phase: Phase<Ctx> = {
      name: 'work',
      async *run() {
        yield { type: 'phase', phase: 'work' };
      },
    };
    const jobId = await runner.create('abort-in-final-result', null);
    const running = runner.run(
      jobId,
      [phase],
      { cache: new PipelineCache(), signal: upstream.signal },
      () => {
        upstream.abort('final-result-abort');
        return 'must-not-complete';
      },
    );

    await expect(running).rejects.toMatchObject({
      name: 'AbortError',
      message: /final-result-abort/,
    });
    expect((await store.getJob(jobId))?.status).toBe('CANCELLED');
    expect((await store.getEvents(jobId)).map((record) => record.eventType)).toEqual([
      'phase',
      'cancellation_requested',
      'cancelled',
    ]);
  });

  it('start() exposes an immediate handle for deterministic subagent deployment', async () => {
    const phase: Phase<Ctx> = {
      name: 'work',
      async *run(ctx) {
        expect(ctx.signal).toBeDefined();
        yield { type: 'phase', phase: 'work' };
      },
    };
    const jobId = await runner.create('handle', null);
    const handle = runner.start(jobId, [phase], { cache: new PipelineCache() });
    expect(handle.jobId).toBe(jobId);
    expect(handle.signal).toBe(runner.signalFor(jobId));
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
  });
});
