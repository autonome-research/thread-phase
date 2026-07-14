/**
 * SSE helper — verifies the wire format and replay-on-reconnect behavior.
 *
 * Uses an in-memory "response" that captures writes so we can assert on the
 * SSE frames without binding to a real HTTP server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JobRunner } from '../src/session/job-runner.js';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import { streamToSSE, type SSEResponse } from '../src/session/sse.js';
import { PipelineCache } from '../src/cache.js';
import type { Phase, BasePipelineContext } from '../src/phase.js';

interface Ctx extends BasePipelineContext {}

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
  off(_evt: 'close' | 'drain', listener: () => void): void {
    this.closeListeners = this.closeListeners.filter((candidate) => candidate !== listener);
  }
  once(_evt: 'drain', _listener: () => void): void {
    // Writes never backpressure in the default fake.
  }
  output(): string {
    return this.chunks.join('');
  }
}

let dir: string;
let store: SqliteJobStore;
let runner: JobRunner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thread-phase-sse-'));
  store = new SqliteJobStore(join(dir, 'sse.db'));
  runner = new JobRunner(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('streamToSSE — wire format', () => {
  it('rejects response adapters without listener cleanup methods', async () => {
    const jobId = await runner.create('invalid-response', null);
    const res = { write: () => true, end() {}, on() {} } as unknown as SSEResponse;
    await expect(streamToSSE({ runner, store, jobId, res })).rejects.toThrow(
      'SSEResponse must implement off()',
    );
  });

  it('emits id/event/data lines per event and closes on done', async () => {
    const phase: Phase<Ctx> = {
      name: 'p',
      async *run() {
        yield { type: 'phase', phase: 'p', detail: 'start' };
        yield { type: 'content', content: 'hello' };
      },
    };
    const jobId = await runner.create('sse-test', null);
    const res = new FakeRes();
    const ssePromise = streamToSSE({
      runner,
      store,
      jobId,
      res,
      heartbeatMs: 0,
    });
    // Run pipeline AFTER subscribing — gives streamToSSE time to attach.
    await runner.run(jobId, [phase], { cache: new PipelineCache() });
    await ssePromise;

    const out = res.output();
    expect(out).toMatch(/event: phase\n/);
    expect(out).toMatch(/event: content\n/);
    expect(out).toMatch(/event: done\n/);
    // Frame format: id: N\nevent: T\ndata: JSON\n\n
    expect(out).toMatch(/id: \d+\nevent: \w+\ndata: \{[^\n]*\}\n\n/);
  });

  it('does not miss a close emitted synchronously by a backpressured write', async () => {
    const jobId = await runner.create('sync-close', null);
    await store.appendEvent(jobId, { type: 'content', content: 'close-now' });
    class SynchronousCloseRes extends FakeRes {
      override write(chunk: string): boolean {
        this.chunks.push(chunk);
        this.end();
        return false;
      }
    }
    const res = new SynchronousCloseRes();
    await expect(streamToSSE({ runner, store, jobId, res, heartbeatMs: 0 })).resolves.toBeUndefined();
  });

  it('resolves backpressure waits when the client closes without drain', async () => {
    const jobId = await runner.create('backpressure-close', null);
    await store.appendEvent(jobId, { type: 'content', content: 'blocked' });
    class BackpressureRes extends FakeRes {
      override write(chunk: string): boolean {
        this.chunks.push(chunk);
        return false;
      }
      disconnect(): void {
        this.closed = true;
        for (const listener of this.closeListeners) listener();
      }
    }
    const res = new BackpressureRes();
    const stream = streamToSSE({ runner, store, jobId, res, heartbeatMs: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    res.disconnect();
    await expect(stream).resolves.toBeUndefined();
  });

  it('replays past events when client supplies afterId=0 after job completed', async () => {
    const phase: Phase<Ctx> = {
      name: 'p',
      async *run() {
        yield { type: 'phase', phase: 'p' };
        yield { type: 'content', content: 'x' };
      },
    };
    const jobId = await runner.create('replay', null);
    await runner.run(jobId, [phase], { cache: new PipelineCache() });
    // Job is done. Now connect.
    const res = new FakeRes();
    await streamToSSE({ runner, store, jobId, res, heartbeatMs: 0 });
    const out = res.output();
    expect(out).toMatch(/event: phase\n/);
    expect(out).toMatch(/event: content\n/);
    expect(out).toMatch(/event: done\n/);
  });

  it('polls durable events finalized by another JobRunner instance', async () => {
    const jobId = await runner.create('cross-runner', null);
    const res = new FakeRes();
    const stream = streamToSSE({ runner, store, jobId, res, heartbeatMs: 0, pollMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const otherRunner = new JobRunner(store);
    await otherRunner.run(jobId, [{ name: 'remote', async *run() { yield { type: 'phase', phase: 'remote' }; } }], { cache: new PipelineCache() });
    await stream;
    expect(res.output()).toContain('event: done');
    expect(res.closed).toBe(true);
  });

  it('does not lose a terminal event emitted during replay-to-live handoff', async () => {
    const jobId = await runner.create('handoff-race', null);
    await store.setRunning(jobId);
    const originalGetJob = store.getJob.bind(store);
    let injected = false;
    vi.spyOn(store, 'getJob').mockImplementation(async (...args) => {
      if (!injected) {
        injected = true;
        const data = { type: 'done' as const };
        const id = await store.appendEvent(jobId, data);
        await store.setCompleted(jobId, null);
        runner.emit(`job:${jobId}`, {
          id,
          jobId,
          eventType: 'done',
          data,
          createdAt: new Date().toISOString(),
        });
      }
      return originalGetJob(...args);
    });

    const res = new FakeRes();
    await streamToSSE({ runner, store, jobId, res, heartbeatMs: 0 });
    expect(res.output().match(/event: done/g)).toHaveLength(1);
    expect(res.closed).toBe(true);
  });

  it('replays only events after Last-Event-ID', async () => {
    const phase: Phase<Ctx> = {
      name: 'p',
      async *run() {
        yield { type: 'phase', phase: 'p' };
        yield { type: 'content', content: 'x' };
        yield { type: 'content', content: 'y' };
      },
    };
    const jobId = await runner.create('partial-replay', null);
    await runner.run(jobId, [phase], { cache: new PipelineCache() });

    const events = await store.getEvents(jobId);
    const phaseEventId = events.find((e) => e.eventType === 'phase')!.id;

    const res = new FakeRes();
    await streamToSSE({ runner, store, jobId, res, afterId: phaseEventId, heartbeatMs: 0 });

    // The phase event should be SKIPPED (id <= afterId), but the content
    // events should all appear.
    const lines = res.output().split('\n\n');
    const eventTypes = lines
      .map((l) => l.match(/event: (\w+)/)?.[1])
      .filter(Boolean);
    expect(eventTypes).not.toContain('phase');
    expect(eventTypes).toContain('content');
    expect(eventTypes).toContain('done');
  });
});
