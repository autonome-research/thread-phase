import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
let store: SqliteJobStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thread-phase-test-'));
  store = new SqliteJobStore(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteJobStore — lifecycle', () => {
  it('createJob returns a uuid and inserts a PENDING row', () => {
    const id = store.createJob('p1', { hello: 'world' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const job = store.getJob(id);
    expect(job).toMatchObject({
      id,
      name: 'p1',
      input: { hello: 'world' },
      status: 'PENDING',
      result: null,
      error: null,
      eventCount: 0,
    });
    expect(job!.startedAt).toBeNull();
    expect(job!.completedAt).toBeNull();
  });

  it('setRunning sets status + startedAt', () => {
    const id = store.createJob('p', null);
    store.setRunning(id);
    const job = store.getJob(id)!;
    expect(job.status).toBe('RUNNING');
    expect(job.startedAt).toBeInstanceOf(Date);
  });

  it('setCompleted persists result + completedAt', () => {
    const id = store.createJob('p', null);
    store.setCompleted(id, { final: 42 });
    const job = store.getJob(id)!;
    expect(job.status).toBe('COMPLETED');
    expect(job.result).toEqual({ final: 42 });
    expect(job.completedAt).toBeInstanceOf(Date);
  });

  it('setFailed persists error message', () => {
    const id = store.createJob('p', null);
    store.setFailed(id, 'kaboom');
    const job = store.getJob(id)!;
    expect(job.status).toBe('FAILED');
    expect(job.error).toBe('kaboom');
  });

  it('getJob returns null for missing id', () => {
    expect(store.getJob('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('SqliteJobStore — events', () => {
  it('appendEvent returns a monotonic id starting at 1', () => {
    const j = store.createJob('p', null);
    expect(store.appendEvent(j, { type: 'phase', phase: 'a' })).toBe(1);
    expect(store.appendEvent(j, { type: 'content', content: 'x' })).toBe(2);
    expect(store.appendEvent(j, { type: 'done' })).toBe(3);
  });

  it('getEvents returns all events for a job in id order', () => {
    const j = store.createJob('p', null);
    store.appendEvent(j, { type: 'phase', phase: 'a' });
    store.appendEvent(j, { type: 'content', content: 'x' });
    store.appendEvent(j, { type: 'done' });
    const evs = store.getEvents(j);
    expect(evs.map((e) => [e.id, e.eventType])).toEqual([
      [1, 'phase'],
      [2, 'content'],
      [3, 'done'],
    ]);
    expect(evs[0]!.data).toEqual({ type: 'phase', phase: 'a' });
  });

  it('getEvents(jobId, afterId) returns only the tail (resume cursor)', () => {
    const j = store.createJob('p', null);
    store.appendEvent(j, { type: 'phase', phase: 'a' });
    store.appendEvent(j, { type: 'content', content: 'x' });
    store.appendEvent(j, { type: 'done' });
    const tail = store.getEvents(j, 1);
    expect(tail.map((e) => e.id)).toEqual([2, 3]);
  });

  it('getJob.eventCount reflects appended events', () => {
    const j = store.createJob('p', null);
    store.appendEvent(j, { type: 'done' });
    store.appendEvent(j, { type: 'done' });
    expect(store.getJob(j)!.eventCount).toBe(2);
  });

  it('events from different jobs are isolated', () => {
    const a = store.createJob('p', null);
    const b = store.createJob('p', null);
    store.appendEvent(a, { type: 'phase', phase: 'a' });
    store.appendEvent(b, { type: 'phase', phase: 'b' });
    expect(store.getEvents(a)).toHaveLength(1);
    expect(store.getEvents(b)).toHaveLength(1);
    expect(store.getEvents(a)[0]!.data).toEqual({ type: 'phase', phase: 'a' });
  });
});

describe('SqliteJobStore — listJobs', () => {
  it('returns most-recent first', async () => {
    const a = store.createJob('p1', null);
    // Sleep long enough that sqlite's second-resolution timestamp differs.
    await new Promise((r) => setTimeout(r, 1100));
    const b = store.createJob('p2', null);
    const list = store.listJobs();
    expect(list[0]!.id).toBe(b);
    expect(list[1]!.id).toBe(a);
  });

  it('filters by name', () => {
    store.createJob('p1', null);
    store.createJob('p2', null);
    const list = store.listJobs({ name: 'p1' });
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('p1');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) store.createJob('p', null);
    expect(store.listJobs({ limit: 2 })).toHaveLength(2);
  });
});
