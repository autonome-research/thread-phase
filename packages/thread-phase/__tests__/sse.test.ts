/**
 * SSE helper — verifies the wire format and replay-on-reconnect behavior.
 *
 * Uses an in-memory "response" that captures writes so we can assert on the
 * SSE frames without binding to a real HTTP server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  it('emits id/event/data lines per event and closes on done', async () => {
    const phase: Phase<Ctx> = {
      name: 'p',
      async *run() {
        yield { type: 'phase', phase: 'p', detail: 'start' };
        yield { type: 'content', content: 'hello' };
      },
    };
    const jobId = runner.create('sse-test', null);
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

  it('replays past events when client supplies afterId=0 after job completed', async () => {
    const phase: Phase<Ctx> = {
      name: 'p',
      async *run() {
        yield { type: 'phase', phase: 'p' };
        yield { type: 'content', content: 'x' };
      },
    };
    const jobId = runner.create('replay', null);
    await runner.run(jobId, [phase], { cache: new PipelineCache() });
    // Job is done. Now connect.
    const res = new FakeRes();
    await streamToSSE({ runner, store, jobId, res, heartbeatMs: 0 });
    const out = res.output();
    expect(out).toMatch(/event: phase\n/);
    expect(out).toMatch(/event: content\n/);
    expect(out).toMatch(/event: done\n/);
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
    const jobId = runner.create('partial-replay', null);
    await runner.run(jobId, [phase], { cache: new PipelineCache() });

    const events = store.getEvents(jobId);
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
