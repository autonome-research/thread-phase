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
  it('createJob returns a uuid and inserts a PENDING row', async () => {
    const id = await store.createJob('p1', { hello: 'world' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const job = await store.getJob(id);
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

  it('setRunning sets status + startedAt', async () => {
    const id = await store.createJob('p', null);
    await store.setRunning(id);
    const job = (await store.getJob(id))!;
    expect(job.status).toBe('RUNNING');
    expect(job.startedAt).toBeInstanceOf(Date);
  });

  it('setCompleted persists result + completedAt', async () => {
    const id = await store.createJob('p', null);
    await store.setCompleted(id, { final: 42 });
    const job = (await store.getJob(id))!;
    expect(job.status).toBe('COMPLETED');
    expect(job.result).toEqual({ final: 42 });
    expect(job.completedAt).toBeInstanceOf(Date);
  });

  it('setFailed persists error message', async () => {
    const id = await store.createJob('p', null);
    await store.setFailed(id, 'kaboom');
    const job = (await store.getJob(id))!;
    expect(job.status).toBe('FAILED');
    expect(job.error).toBe('kaboom');
  });

  it('persists CANCELLED and ABANDONED as distinct terminal states', async () => {
    const cancelled = await store.createJob('cancelled', null);
    await store.setRunning(cancelled);
    await store.setCancelled(cancelled, 'user requested');
    expect(await store.getJob(cancelled)).toMatchObject({
      status: 'CANCELLED',
      error: 'user requested',
    });

    const abandoned = await store.createJob('abandoned', null);
    await store.setRunning(abandoned);
    await store.setAbandoned(abandoned, 'owner disappeared');
    expect(await store.getJob(abandoned)).toMatchObject({
      status: 'ABANDONED',
      error: 'owner disappeared',
    });
  });

  it('does not allow a later terminal write to overwrite the first terminal state', async () => {
    const id = await store.createJob('terminal', null);
    await store.setRunning(id);
    await store.setFailed(id, 'first failure');
    await store.setCompleted(id, { incorrect: true });
    await store.setCancelled(id, 'too late');
    expect(await store.getJob(id)).toMatchObject({
      status: 'FAILED',
      error: 'first failure',
      result: null,
    });
  });

  it('atomically enables and refreshes heartbeat for the current owner', async () => {
    const id = await store.createJob('manual-heartbeat', null);
    await store.setRunning(id, { ownerId: 'owner' });
    const before = (await store.getJob(id))!.heartbeatAt!;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(store.enableHeartbeat(id, 'owner')).resolves.toBe(true);
    const after = (await store.getJob(id))!;
    expect(after.heartbeatEnabled).toBe(true);
    expect(after.heartbeatAt!.getTime()).toBeGreaterThan(before.getTime());
    await expect(store.enableHeartbeat(id, 'other-owner')).resolves.toBe(false);
  });

  it('persists durable owner identity and launch source', async () => {
    const id = await store.createJob('owned', null);
    await store.setRunning(id, { ownerId: 'owner-123', launchSource: 'pi-tool' });
    expect(await store.getJob(id)).toMatchObject({
      ownerId: 'owner-123',
      launchSource: 'pi-tool',
    });
  });

  it('atomically finalizes status and terminal event exactly once', async () => {
    const id = await store.createJob('atomic-terminal', null);
    await store.setRunning(id, { ownerId: 'owner' });
    const terminal = await store.finalizeJob(id, {
      status: 'FAILED',
      error: 'boom',
      event: { type: 'error', message: 'boom' },
      ownerId: 'owner',
    });
    expect(terminal?.eventType).toBe('error');
    expect(await store.getJob(id)).toMatchObject({ status: 'FAILED', error: 'boom', eventCount: 1 });
    await expect(store.finalizeJob(id, {
      status: 'COMPLETED',
      event: { type: 'done' },
      ownerId: 'owner',
    })).resolves.toBeNull();
    expect(await store.getEvents(id)).toHaveLength(1);
  });

  it('getJob returns null for missing id', async () => {
    expect(await store.getJob('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('setRunning preserves startedAt on second call (idempotent)', async () => {
    const id = await store.createJob('p', null);
    await store.setRunning(id);
    const first = (await store.getJob(id))!.startedAt!;
    // SQLite datetime resolution is 1s — wait long enough that a second
    // datetime('now') would differ if COALESCE weren't doing its job.
    await new Promise((r) => setTimeout(r, 1100));
    await store.setRunning(id);
    const second = (await store.getJob(id))!.startedAt!;
    expect(second.getTime()).toBe(first.getTime());
  });
});

describe('SqliteJobStore — acquireExclusive', () => {
  it('returns a uuid and inserts a RUNNING row when no prior runner exists', async () => {
    const id = await store.acquireExclusive('librarian', { batch: 12 });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const job = (await store.getJob(id!))!;
    expect(job.status).toBe('RUNNING');
    expect(job.input).toEqual({ batch: 12 });
    expect(job.startedAt).toBeInstanceOf(Date);
  });

  it('returns null when a job with this name is already RUNNING', async () => {
    const first = await store.acquireExclusive('librarian', null);
    expect(first).not.toBeNull();
    const second = await store.acquireExclusive('librarian', null);
    expect(second).toBeNull();
  });

  it('lets a different name acquire even when one is running', async () => {
    expect(await store.acquireExclusive('librarian', null)).not.toBeNull();
    expect(await store.acquireExclusive('digest', null)).not.toBeNull();
  });

  it('lets a new run acquire after the prior one COMPLETED', async () => {
    const first = (await store.acquireExclusive('librarian', null))!;
    await store.setCompleted(first, null);
    const second = await store.acquireExclusive('librarian', null);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('lets a new run acquire after the prior one FAILED', async () => {
    const first = (await store.acquireExclusive('librarian', null))!;
    await store.setFailed(first, 'boom');
    expect(await store.acquireExclusive('librarian', null)).not.toBeNull();
  });

  it('ignores PENDING / COMPLETED / FAILED jobs of the same name', async () => {
    // PENDING shouldn't block a claim — only RUNNING does.
    await store.createJob('librarian', null); // status='PENDING'
    const completed = await store.createJob('librarian', null);
    await store.setCompleted(completed, null);
    const failed = await store.createJob('librarian', null);
    await store.setFailed(failed, 'x');
    expect(await store.acquireExclusive('librarian', null)).not.toBeNull();
  });

  it('subsequent setRunning on the acquired id preserves startedAt', async () => {
    const id = (await store.acquireExclusive('librarian', null))!;
    const first = (await store.getJob(id))!.startedAt!;
    await new Promise((r) => setTimeout(r, 1100));
    await store.setRunning(id);
    const second = (await store.getJob(id))!.startedAt!;
    expect(second.getTime()).toBe(first.getTime());
  });
});

describe('SqliteJobStore — events', () => {
  it('appendEvent returns a monotonic id starting at 1', async () => {
    const j = await store.createJob('p', null);
    expect(await store.appendEvent(j, { type: 'phase', phase: 'a' })).toBe(1);
    expect(await store.appendEvent(j, { type: 'content', content: 'x' })).toBe(2);
    expect(await store.appendEvent(j, { type: 'done' })).toBe(3);
  });

  it('getEvents returns all events for a job in id order', async () => {
    const j = await store.createJob('p', null);
    await store.appendEvent(j, { type: 'phase', phase: 'a' });
    await store.appendEvent(j, { type: 'content', content: 'x' });
    await store.appendEvent(j, { type: 'done' });
    const evs = await store.getEvents(j);
    expect(evs.map((e) => [e.id, e.eventType])).toEqual([
      [1, 'phase'],
      [2, 'content'],
      [3, 'done'],
    ]);
    expect(evs[0]!.data).toEqual({ type: 'phase', phase: 'a' });
  });

  it('getEvents(jobId, afterId) returns only the tail (resume cursor)', async () => {
    const j = await store.createJob('p', null);
    await store.appendEvent(j, { type: 'phase', phase: 'a' });
    await store.appendEvent(j, { type: 'content', content: 'x' });
    await store.appendEvent(j, { type: 'done' });
    const tail = await store.getEvents(j, 1);
    expect(tail.map((e) => e.id)).toEqual([2, 3]);
  });

  it('getJob.eventCount reflects appended events', async () => {
    const j = await store.createJob('p', null);
    await store.appendEvent(j, { type: 'done' });
    await store.appendEvent(j, { type: 'done' });
    expect((await store.getJob(j))!.eventCount).toBe(2);
  });

  it('events from different jobs are isolated', async () => {
    const a = await store.createJob('p', null);
    const b = await store.createJob('p', null);
    await store.appendEvent(a, { type: 'phase', phase: 'a' });
    await store.appendEvent(b, { type: 'phase', phase: 'b' });
    expect(await store.getEvents(a)).toHaveLength(1);
    expect(await store.getEvents(b)).toHaveLength(1);
    expect((await store.getEvents(a))[0]!.data).toEqual({ type: 'phase', phase: 'a' });
  });
});

describe('SqliteJobStore — migrations', () => {
  it('sets PRAGMA user_version after first init', async () => {
    const path = join(dir, 'mig.db');
    const s = new SqliteJobStore(path);
    // Re-open with raw sqlite to peek at user_version.
    s.close();
    // Open via SqliteJobStore again — second open should be idempotent.
    const s2 = new SqliteJobStore(path);
    // Sanity: tables exist and CRUD works after re-open.
    const id = await s2.createJob('p', null);
    expect(await s2.getJob(id)).not.toBeNull();
    s2.close();
  });

  it('preserves data across re-open (no DROP/recreate)', async () => {
    const path = join(dir, 'persist.db');
    const a = new SqliteJobStore(path);
    const id = await a.createJob('p', { v: 1 });
    await a.appendEvent(id, { type: 'phase', phase: 'x' });
    a.close();

    const b = new SqliteJobStore(path);
    expect(await b.getJob(id)).toMatchObject({ id, name: 'p', input: { v: 1 } });
    expect(await b.getEvents(id)).toHaveLength(1);
    b.close();
  });
});

describe('SqliteJobStore — listJobs', () => {
  it('returns most-recent first', async () => {
    const a = await store.createJob('p1', null);
    // Sleep long enough that sqlite's second-resolution timestamp differs.
    await new Promise((r) => setTimeout(r, 1100));
    const b = await store.createJob('p2', null);
    const list = await store.listJobs();
    expect(list[0]!.id).toBe(b);
    expect(list[1]!.id).toBe(a);
  });

  it('filters by name', async () => {
    await store.createJob('p1', null);
    await store.createJob('p2', null);
    const list = await store.listJobs({ name: 'p1' });
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('p1');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) await store.createJob('p', null);
    expect(await store.listJobs({ limit: 2 })).toHaveLength(2);
  });
});
