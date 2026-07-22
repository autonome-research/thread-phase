import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteJobStore } from '../src/session/sqlite-job-store.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

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

  it('returns one winner and one null across contending child processes', async () => {
    const path = join(dir, 'cross-process-acquire.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();
    const children = [spawnAcquisitionChild(), spawnAcquisitionChild()];
    let locker: InstanceType<typeof Database> | undefined;

    try {
      await Promise.all(children.map((child) => child.waitFor('ready')));
      for (const child of children) child.process.send?.({ type: 'open', dbPath: path });
      const opened = await Promise.all(children.map((child) => child.waitFor('opened')));
      expect(opened).toEqual([
        expect.not.objectContaining({ ok: false }),
        expect.not.objectContaining({ ok: false }),
      ]);

      // Hold an explicit write barrier so both real processes begin acquisition
      // before either can win. No scheduler timing or sleep triggers contention.
      locker = new Database(path);
      locker.exec('BEGIN IMMEDIATE');
      children.forEach((child, index) => child.process.send?.({
        type: 'acquire',
        name: 'shared-name',
        input: { contender: index },
      }));
      await Promise.all(children.map((child) => child.waitFor('acquiring')));
      locker.exec('COMMIT');

      const results = await Promise.all(children.map((child) => child.waitFor('result')));
      expect(results.filter((result) => typeof result.jobId === 'string')).toHaveLength(1);
      expect(results.filter((result) => result.jobId === null)).toHaveLength(1);
      expect(results.every((result) => result.ok === true)).toBe(true);
      await Promise.all(children.map((child) => child.closeNormally()));
    } finally {
      if (locker?.inTransaction) locker.exec('ROLLBACK');
      locker?.close();
      await Promise.all(children.map((child) => child.cleanupAfterFailure()));
    }

    const inspect = new Database(path);
    expect(
      inspect.prepare(
        `SELECT COUNT(*) AS count FROM job WHERE name = ? AND status = 'RUNNING'`,
      ).get('shared-name'),
    ).toEqual({ count: 1 });
    inspect.close();
  }, 15_000);
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
    s.close();

    const raw = new Database(path);
    expect(raw.pragma('user_version', { simple: true })).toBe(5);
    raw.close();

    // A repeated open is an idempotent no-op.
    const s2 = new SqliteJobStore(path);
    const id = await s2.createJob('p', null);
    expect(await s2.getJob(id)).not.toBeNull();
    s2.close();
  });

  it('fails closed when a current-version database is missing the exclusivity index', () => {
    const path = join(dir, 'missing-index-v5.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();

    const seed = new Database(path);
    seed.exec('DROP INDEX idx_job_one_running_per_name');
    expect(seed.pragma('user_version', { simple: true })).toBe(5);
    seed.close();

    expect(() => new SqliteJobStore(path)).toThrow(/migration 5 schema collision/);

    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(5);
    expect(inspect.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_job_one_running_per_name'`,
    ).get()).toBeUndefined();
    inspect.close();
  });

  it('fails closed when a current-version database has an incompatible exclusivity index', () => {
    const path = join(dir, 'wrong-index-v5.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();

    const seed = new Database(path);
    seed.exec(`
      DROP INDEX idx_job_one_running_per_name;
      CREATE INDEX idx_job_one_running_per_name ON job (name);
    `);
    const before = seed.prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE name = 'idx_job_one_running_per_name'`,
    ).get();
    expect(seed.pragma('user_version', { simple: true })).toBe(5);
    seed.close();

    expect(() => new SqliteJobStore(path)).toThrow(/migration 5 schema collision/);

    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(5);
    expect(inspect.prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE name = 'idx_job_one_running_per_name'`,
    ).get()).toEqual(before);
    inspect.close();
  });

  it('enforces at most one exact-name RUNNING row in the database', async () => {
    const first = await store.createJob('same-name', null);
    const second = await store.createJob('same-name', null);
    const caseDistinct = await store.createJob('SAME-NAME', null);

    await expect(store.setRunning(first)).resolves.toBe(true);
    await expect(store.setRunning(second)).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(store.setRunning(caseDistinct)).resolves.toBe(true);
    expect(await store.getJob(second)).toMatchObject({ status: 'PENDING', startedAt: null });
  });

  it('transactionally verifies an already-installed compatible v5 index before advancing', () => {
    const path = join(dir, 'verified-v4.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();

    const seed = new Database(path);
    seed.exec(`
      DROP INDEX idx_job_one_running_per_name;
      CREATE UNIQUE INDEX idx_job_one_running_per_name
        ON job ("name") WHERE (("STATUS" = 'RUNNING'));
      PRAGMA user_version = 4;
    `);
    seed.close();

    const migrated = new SqliteJobStore(path);
    migrated.close();
    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(5);
    expect(
      inspect.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_job_one_running_per_name'`,
      ).get(),
    ).toEqual({ count: 1 });
    inspect.close();
  });

  it('fails closed when a trigger shares the selected index name', () => {
    const path = join(dir, 'trigger-collision-v4.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();

    const seed = new Database(path);
    seed.exec(`
      DROP INDEX idx_job_one_running_per_name;
      CREATE TRIGGER idx_job_one_running_per_name
        AFTER INSERT ON event BEGIN SELECT 1; END;
      PRAGMA user_version = 4;
    `);
    const before = seed.prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE name = 'idx_job_one_running_per_name'`,
    ).all();
    seed.close();

    expect(() => new SqliteJobStore(path)).toThrow(/migration 5 schema collision/);

    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(4);
    expect(inspect.prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE name = 'idx_job_one_running_per_name'`,
    ).all()).toEqual(before);
    expect(inspect.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_job_one_running_per_name'`,
    ).get()).toBeUndefined();
    inspect.close();
  });

  it('fails closed when a same-named non-unique index exists without conflicting rows', () => {
    const path = join(dir, 'non-unique-index-v4.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();

    const seed = new Database(path);
    seed.exec(`
      DROP INDEX idx_job_one_running_per_name;
      CREATE INDEX idx_job_one_running_per_name ON job (name);
      PRAGMA user_version = 4;
    `);
    const before = seed.prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE name = 'idx_job_one_running_per_name'`,
    ).get();
    seed.close();

    expect(() => new SqliteJobStore(path)).toThrow(/migration 5 schema collision/);

    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(4);
    expect(inspect.prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE name = 'idx_job_one_running_per_name'`,
    ).get()).toEqual(before);
    expect(inspect.prepare('SELECT COUNT(*) AS count FROM job').get()).toEqual({ count: 0 });
    inspect.close();
  });

  it('rejects a same-named index whose predicate value differs only by case', () => {
    const path = join(dir, 'lowercase-predicate-v4.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();

    const seed = new Database(path);
    seed.exec(`
      DROP INDEX idx_job_one_running_per_name;
      CREATE UNIQUE INDEX idx_job_one_running_per_name
        ON job (name) WHERE status = 'running';
      PRAGMA user_version = 4;
    `);
    seed.close();

    expect(() => new SqliteJobStore(path)).toThrow(/migration 5 schema collision/);

    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(4);
    expect(inspect.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_job_one_running_per_name'`,
    ).get()).toEqual(expect.objectContaining({ sql: expect.stringContaining("'running'") }));
    inspect.close();
  });

  it('fails closed on a wrong-predicate same-named index and preserves conflicting rows', () => {
    const path = join(dir, 'wrong-predicate-index-v4.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();

    const seed = new Database(path);
    seed.exec(`
      DROP INDEX idx_job_one_running_per_name;
      CREATE UNIQUE INDEX idx_job_one_running_per_name
        ON job (name) WHERE status = 'PENDING';
      PRAGMA user_version = 4;
      INSERT INTO job (id, name, input, status, started_at)
        VALUES ('collision-a', 'duplicate', '{}', 'RUNNING', '2025-01-01 00:00:00');
      INSERT INTO job (id, name, input, status, started_at)
        VALUES ('collision-b', 'duplicate', '{}', 'RUNNING', '2025-01-02 00:00:00');
    `);
    const beforeRows = seed.prepare('SELECT * FROM job ORDER BY id').all();
    const beforeIndex = seed.prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE name = 'idx_job_one_running_per_name'`,
    ).get();
    seed.close();

    expect(() => new SqliteJobStore(path)).toThrow(/migration 5 schema collision/);

    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(4);
    expect(inspect.prepare('SELECT * FROM job ORDER BY id').all()).toEqual(beforeRows);
    expect(inspect.prepare(
      `SELECT type, tbl_name, sql FROM sqlite_master
       WHERE name = 'idx_job_one_running_per_name'`,
    ).get()).toEqual(beforeIndex);
    inspect.close();
  });

  it('fails closed on historical conflicts without changing rows or user_version', () => {
    const path = join(dir, 'conflicting-v4.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();

    const seed = new Database(path);
    seed.exec(`
      DROP INDEX idx_job_one_running_per_name;
      PRAGMA user_version = 4;
      INSERT INTO job (id, name, input, status, started_at)
        VALUES ('conflict-a', 'duplicate', '{"source":"a"}', 'RUNNING', '2025-01-01 00:00:00');
      INSERT INTO job (id, name, input, status, started_at)
        VALUES ('conflict-b', 'duplicate', '{"source":"b"}', 'RUNNING', '2025-01-02 00:00:00');
    `);
    const before = seed.prepare('SELECT * FROM job ORDER BY id').all();
    seed.close();

    expect(() => new SqliteJobStore(path)).toThrow(/UNIQUE constraint failed/);

    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(4);
    expect(inspect.prepare('SELECT * FROM job ORDER BY id').all()).toEqual(before);
    expect(
      inspect.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_job_one_running_per_name'`,
      ).get(),
    ).toBeUndefined();
    inspect.close();
  });

  it('serializes concurrent process initialization and applies the migration once', async () => {
    const path = join(dir, 'concurrent-v4.db');
    const initialized = new SqliteJobStore(path);
    initialized.close();
    const locker = new Database(path);
    locker.exec('DROP INDEX idx_job_one_running_per_name; PRAGMA user_version = 4; BEGIN IMMEDIATE');

    const children = [spawnMigrationChild(), spawnMigrationChild()];
    try {
      await Promise.all(children.map((child) => child.waitFor('ready')));
      for (const child of children) child.process.send?.({ type: 'start', dbPath: path });
      await Promise.all(children.map((child) => child.waitFor('opening')));

      // Both independent open attempts are active behind an explicit database
      // write barrier; releasing it lets the migration transactions serialize.
      locker.exec('COMMIT');
      const results = await Promise.all(children.map((child) => child.waitFor('result')));
      expect(results).toEqual([
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: true }),
      ]);

      await Promise.all(children.map((child) => child.closeNormally()));
    } finally {
      if (locker.inTransaction) locker.exec('ROLLBACK');
      locker.close();
      await Promise.all(children.map((child) => child.cleanupAfterFailure()));
    }

    const inspect = new Database(path);
    expect(inspect.pragma('user_version', { simple: true })).toBe(5);
    expect(
      inspect.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_job_one_running_per_name'`,
      ).get(),
    ).toEqual({ count: 1 });
    inspect.close();
  }, 15_000);

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

interface SqliteChild {
  process: ChildProcess;
  waitFor(type: string): Promise<Record<string, unknown>>;
  closeNormally(): Promise<void>;
  cleanupAfterFailure(): Promise<void>;
}

function spawnMigrationChild(): SqliteChild {
  return spawnSqliteChild('./fixtures/sqlite-migration-child.ts');
}

function spawnAcquisitionChild(): SqliteChild {
  return spawnSqliteChild('./fixtures/sqlite-acquire-child.ts');
}

function spawnSqliteChild(relativeFixture: string): SqliteChild {
  const fixture = fileURLToPath(new URL(relativeFixture, import.meta.url));
  const child = fork(fixture, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const messages: Array<Record<string, unknown>> = [];
  const waiters = new Map<string, (message: Record<string, unknown>) => void>();
  child.on('message', (value: unknown) => {
    const message = value as Record<string, unknown>;
    const type = String(message.type);
    const waiter = waiters.get(type);
    if (waiter) {
      waiters.delete(type);
      waiter(message);
    } else {
      messages.push(message);
    }
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const waitForExit = (timeoutMs: number): Promise<number | null | 'timeout'> =>
    new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      const timeout = setTimeout(() => resolve('timeout'), timeoutMs);
      void exited.then((code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

  const waitFor = (type: string): Promise<Record<string, unknown>> => {
    const queued = messages.findIndex((message) => message.type === type);
    if (queued >= 0) return Promise.resolve(messages.splice(queued, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(type);
        reject(new Error(`SQLite child did not report ${type}`));
      }, 5_000);
      waiters.set(type, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });
  };

  return {
    process: child,
    waitFor,
    async closeNormally() {
      child.send({ type: 'close' });
      await waitFor('closed');
      const exitCode = await waitForExit(5_000);
      if (exitCode === 'timeout') {
        throw new Error(`SQLite child ${child.pid ?? 'unknown'} did not exit after close`);
      }
      expect(exitCode).toBe(0);
    },
    async cleanupAfterFailure() {
      if (child.exitCode !== null) return;
      if (child.connected) child.send({ type: 'close' });
      const graceful = await waitForExit(1_000);
      if (graceful !== 'timeout') return;
      // Forced termination is only a last-resort safeguard and explicitly
      // fails the test rather than masquerading as normal lifecycle control.
      child.kill('SIGKILL');
      await waitForExit(1_000);
      throw new Error(`SQLite child ${child.pid ?? 'unknown'} did not exit gracefully`);
    },
  };
}

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
