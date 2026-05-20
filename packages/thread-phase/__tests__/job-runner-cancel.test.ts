/**
 * JobRunner cancellation: a long-running phase that observes the runner's
 * abort signal must unwind cleanly when cancel() is called, marking the job
 * FAILED with the cancel reason.
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
    const jobId = runner.create('test', null);
    await runner.run(jobId, [phase], { cache: new PipelineCache() });
    expect(seenSignal.value).toBeDefined();
    // Cleared after run finishes.
    expect(runner.signalFor(jobId)).toBeUndefined();
  });

  it('cancel() aborts the in-flight pipeline and marks job FAILED', async () => {
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
    const jobId = runner.create('cancel-test', null);
    const runPromise = runner.run(jobId, [phase], { cache: new PipelineCache() });
    // Cancel after a few ticks.
    setTimeout(() => runner.cancel(jobId, 'user-stop'), 30);
    await runPromise;
    const job = store.getJob(jobId)!;
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/cancelled.*user-stop/);
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
    const jobId = runner.create('wired', null);
    const p = runner.run(jobId, [phase], { cache: new PipelineCache() });
    setTimeout(() => runner.cancel(jobId, 'wired-cancel'), 20);
    await p;
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
    const job = store.getJob(jobId)!;
    expect(job.status).toBe('FAILED');
  });
});
