/**
 * sqlite-backed JobStore implementation — the bundled default.
 *
 * Two tables (job, event) on a single sqlite file. WAL journal for write
 * concurrency, foreign keys enforced.
 *
 * The interface (`JobStore`) is async-by-default in v3.0.0; this
 * implementation wraps its sync better-sqlite3 calls in `async` methods.
 * better-sqlite3 stays sync internally — the only overhead is one
 * microtask per call, which is negligible against sqlite's already
 * sub-millisecond write cost. We pay this cost to keep one unified
 * interface across all backends (Postgres, Redis, network stores)
 * instead of two parallel sync + async hierarchies.
 */

import Database, { type Database as DB } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { PipelineEvent } from '../phase.js';
import type {
  EventRecord,
  GetJobOptions,
  JobFinalization,
  JobOwnership,
  JobRecord,
  JobStatus,
  JobStore,
  ListJobsOptions,
} from './job-store.js';

/**
 * Schema migrations.
 *
 * Each entry is one forward step keyed by its target user_version. The
 * migration runner reads `PRAGMA user_version`, applies any unapplied
 * migrations in order inside a transaction per step, and bumps the version.
 *
 * To add a migration: append a new entry with version = (last + 1). NEVER
 * edit a previously-shipped migration — that would leave older databases in
 * an inconsistent state.
 */
interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS job (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        input        TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'PENDING',
        result       TEXT,
        error        TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        started_at   TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_job_name_created
        ON job (name, created_at DESC);

      CREATE TABLE IF NOT EXISTS event (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        data        TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (job_id) REFERENCES job(id)
      );

      CREATE INDEX IF NOT EXISTS idx_event_job_id ON event (job_id, id);
    `,
  },
  {
    // v4.1.0 — ownership metadata + heartbeat for read-time staleness.
    // All columns are optional and additive; older rows have NULL values
    // and continue to work as before.
    version: 2,
    up: `
      ALTER TABLE job ADD COLUMN session_id   TEXT;
      ALTER TABLE job ADD COLUMN pid          INTEGER;
      ALTER TABLE job ADD COLUMN ppid         INTEGER;
      ALTER TABLE job ADD COLUMN cwd          TEXT;
      ALTER TABLE job ADD COLUMN hostname     TEXT;
      ALTER TABLE job ADD COLUMN heartbeat_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_job_status_heartbeat
        ON job (status, heartbeat_at);
    `,
  },
  {
    // Reliable ownership claims. owner_id distinguishes a live owner from a
    // recycled PID; launch_source lets hosts apply consistent visibility and
    // authorization policy without encoding it in event payloads.
    version: 3,
    up: `
      ALTER TABLE job ADD COLUMN owner_id     TEXT;
      ALTER TABLE job ADD COLUMN launch_source TEXT;
    `,
  },
  {
    // Stale reconciliation is opt-in. Runs without automatic heartbeat must
    // never be classified abandoned merely because their initial timestamp ages.
    version: 4,
    up: `
      ALTER TABLE job ADD COLUMN heartbeat_enabled INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

interface JobRow {
  id: string;
  name: string;
  input: string;
  status: JobStatus;
  result: string | null;
  error: string | null;
  event_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  session_id: string | null;
  pid: number | null;
  ppid: number | null;
  cwd: string | null;
  hostname: string | null;
  owner_id: string | null;
  launch_source: string | null;
  heartbeat_enabled: number;
  heartbeat_at: string | null;
}

interface EventRow {
  id: number;
  job_id: string;
  event_type: string;
  data: string;
  created_at: string;
}

function defaultDbPath(): string {
  return process.env.THREAD_PHASE_DB ?? './thread-phase.db';
}

function parseDate(s: string | null): Date | null {
  return s ? new Date(s + 'Z') : null;
}

export class SqliteJobStore implements JobStore {
  private db: DB;

  constructor(dbPath: string = defaultDbPath()) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
  }

  /**
   * Apply any unapplied migrations. Reads `PRAGMA user_version`, applies
   * each entry from `MIGRATIONS` whose version is greater, inside a
   * transaction per step, then bumps user_version.
   *
   * Idempotent: running twice is a no-op once the schema is current.
   */
  private runMigrations(): void {
    const current = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.db.transaction(() => {
        this.db.exec(m.up);
        // user_version is an integer pragma; better-sqlite3 doesn't support
        // parameter binding for pragmas, so interpolate the integer directly.
        this.db.pragma(`user_version = ${m.version}`);
      })();
    }
  }

  // -------------------------------------------------------------------------
  // Job lifecycle
  // -------------------------------------------------------------------------

  async createJob(name: string, input: unknown): Promise<string> {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO job (id, name, input) VALUES (?, ?, ?)`)
      .run(id, name, JSON.stringify(input));
    return id;
  }

  async acquireExclusive(name: string, input: unknown): Promise<string | null> {
    // better-sqlite3's `db.transaction(fn)` wraps the callback in BEGIN…COMMIT
    // (defaults to deferred, but the runtime upgrades to a write lock the
    // moment we INSERT, which serializes concurrent acquireExclusive calls
    // on the same DB file). The check + insert therefore happens atomically:
    // a second caller racing on the same name will see the row we just
    // inserted (status='RUNNING') and return null.
    const tx = this.db.transaction((n: string, i: unknown): string | null => {
      const existing = this.db
        .prepare(`SELECT id FROM job WHERE name = ? AND status = 'RUNNING' LIMIT 1`)
        .get(n) as { id: string } | undefined;
      if (existing) return null;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO job (id, name, input, status, started_at)
           VALUES (?, ?, ?, 'RUNNING', datetime('now'))`,
        )
        .run(id, n, JSON.stringify(i));
      return id;
    });
    return tx(name, input);
  }

  async setRunning(jobId: string, ownership?: JobOwnership): Promise<boolean> {
    // COALESCE on started_at: idempotent w.r.t. acquireExclusive, which
    // already sets status='RUNNING' and started_at at claim time.
    // Ownership fields use COALESCE so a re-call without ownership doesn't
    // null out previously-recorded values.
    const result = this.db
      .prepare(
        `UPDATE job SET status       = 'RUNNING',
                        started_at   = COALESCE(started_at, datetime('now')),
                        session_id   = COALESCE(?, session_id),
                        pid          = COALESCE(?, pid),
                        ppid         = COALESCE(?, ppid),
                        cwd          = COALESCE(?, cwd),
                        hostname     = COALESCE(?, hostname),
                        owner_id     = COALESCE(?, owner_id),
                        launch_source = COALESCE(?, launch_source),
                        heartbeat_enabled = COALESCE(?, heartbeat_enabled),
                        heartbeat_at = COALESCE(heartbeat_at, datetime('now'))
         WHERE id = ?
           AND (status = 'PENDING'
                OR (status = 'RUNNING' AND owner_id IS NULL)
                OR (status = 'RUNNING' AND owner_id = ?))`,
      )
      .run(
        ownership?.sessionId ?? null,
        ownership?.pid ?? null,
        ownership?.ppid ?? null,
        ownership?.cwd ?? null,
        ownership?.hostname ?? null,
        ownership?.ownerId ?? null,
        ownership?.launchSource ?? null,
        ownership?.heartbeatEnabled === undefined ? null : Number(ownership.heartbeatEnabled),
        jobId,
        ownership?.ownerId ?? null,
      );
    return result.changes === 1;
  }

  async heartbeat(jobId: string, ownerId?: string): Promise<void> {
    // Owner-aware when called by JobRunner; unguarded calls remain available
    // for operators and backwards-compatible direct store integrations.
    this.db
      .prepare(
        `UPDATE job SET heartbeat_at = datetime('now')
         WHERE id = ? AND status = 'RUNNING'
           AND (? IS NULL OR owner_id = ?)`,
      )
      .run(jobId, ownerId ?? null, ownerId ?? null);
  }

  async enableHeartbeat(jobId: string, ownerId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE job SET heartbeat_enabled = 1, heartbeat_at = datetime('now')
         WHERE id = ? AND status = 'RUNNING' AND owner_id = ?`,
      )
      .run(jobId, ownerId);
    return result.changes === 1;
  }

  async setCompleted(jobId: string, result: unknown, ownerId?: string): Promise<boolean> {
    const resultRow = this.db
      .prepare(
        `UPDATE job SET status = 'COMPLETED', result = ?, error = NULL,
                        completed_at = datetime('now')
         WHERE id = ? AND status IN ('PENDING', 'RUNNING')
           AND (? IS NULL OR owner_id = ?)`,
      )
      .run(JSON.stringify(result ?? null), jobId, ownerId ?? null, ownerId ?? null);
    return resultRow.changes === 1;
  }

  async setFailed(jobId: string, error: string, ownerId?: string): Promise<boolean> {
    const resultRow = this.db
      .prepare(
        `UPDATE job SET status = 'FAILED', error = ?, completed_at = datetime('now')
         WHERE id = ? AND status IN ('PENDING', 'RUNNING')
           AND (? IS NULL OR owner_id = ?)`,
      )
      .run(error, jobId, ownerId ?? null, ownerId ?? null);
    return resultRow.changes === 1;
  }

  async setCancelled(jobId: string, reason: string, ownerId?: string): Promise<boolean> {
    const resultRow = this.db
      .prepare(
        `UPDATE job SET status = 'CANCELLED', error = ?, completed_at = datetime('now')
         WHERE id = ? AND status IN ('PENDING', 'RUNNING')
           AND (? IS NULL OR owner_id = ?)`,
      )
      .run(reason, jobId, ownerId ?? null, ownerId ?? null);
    return resultRow.changes === 1;
  }

  async setAbandoned(jobId: string, reason: string): Promise<boolean> {
    const resultRow = this.db
      .prepare(
        `UPDATE job SET status = 'ABANDONED', error = ?, completed_at = datetime('now')
         WHERE id = ? AND status = 'RUNNING'`,
      )
      .run(reason, jobId);
    return resultRow.changes === 1;
  }

  async setAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<boolean> {
    const resultRow = this.db
      .prepare(
        `UPDATE job SET status = 'ABANDONED', error = ?, completed_at = datetime('now')
         WHERE id = ?
           AND status = 'RUNNING'
           AND heartbeat_enabled = 1
           AND (heartbeat_at IS NULL OR heartbeat_at < datetime(?))
           AND (? IS NULL OR owner_id = ?)`,
      )
      .run(
        reason,
        jobId,
        staleBefore.toISOString(),
        expectedOwnerId ?? null,
        expectedOwnerId ?? null,
      );
    return resultRow.changes === 1;
  }

  async finalizeJob(jobId: string, finalization: JobFinalization): Promise<EventRecord | null> {
    const transaction = this.db.transaction((): EventRow | null => {
      const update = this.db
        .prepare(
          `UPDATE job SET status = ?, result = ?, error = ?, completed_at = datetime('now')
           WHERE id = ? AND status IN ('PENDING', 'RUNNING')
             AND (? IS NULL OR owner_id = ?)`,
        )
        .run(
          finalization.status,
          finalization.result === undefined ? null : JSON.stringify(finalization.result),
          finalization.error ?? null,
          jobId,
          finalization.ownerId ?? null,
          finalization.ownerId ?? null,
        );
      if (update.changes !== 1) return null;
      const inserted = this.db
        .prepare(`INSERT INTO event (job_id, event_type, data) VALUES (?, ?, ?)`)
        .run(jobId, finalization.event.type, JSON.stringify(finalization.event));
      return this.db
        .prepare(`SELECT id, job_id, event_type, data, created_at FROM event WHERE id = ?`)
        .get(Number(inserted.lastInsertRowid)) as EventRow;
    });
    const row = transaction();
    return row ? this.toEventRecord(row) : null;
  }

  async finalizeAbandonedIfStale(
    jobId: string,
    staleBefore: Date,
    reason: string,
    expectedOwnerId?: string,
  ): Promise<EventRecord | null> {
    const event: PipelineEvent = { type: 'abandoned', reason };
    const transaction = this.db.transaction((): EventRow | null => {
      const update = this.db
        .prepare(
          `UPDATE job SET status = 'ABANDONED', error = ?, completed_at = datetime('now')
           WHERE id = ? AND status = 'RUNNING' AND heartbeat_enabled = 1
             AND (heartbeat_at IS NULL OR heartbeat_at < datetime(?))
             AND (? IS NULL OR owner_id = ?)`,
        )
        .run(reason, jobId, staleBefore.toISOString(), expectedOwnerId ?? null, expectedOwnerId ?? null);
      if (update.changes !== 1) return null;
      const inserted = this.db
        .prepare(`INSERT INTO event (job_id, event_type, data) VALUES (?, ?, ?)`)
        .run(jobId, event.type, JSON.stringify(event));
      return this.db
        .prepare(`SELECT id, job_id, event_type, data, created_at FROM event WHERE id = ?`)
        .get(Number(inserted.lastInsertRowid)) as EventRow;
    });
    const row = transaction();
    return row ? this.toEventRecord(row) : null;
  }

  // -------------------------------------------------------------------------
  // Job reads
  // -------------------------------------------------------------------------

  async getJob(jobId: string, options: GetJobOptions = {}): Promise<JobRecord | null> {
    const row = this.db
      .prepare(
        `SELECT j.*, (SELECT COUNT(*) FROM event WHERE job_id = j.id) AS event_count
         FROM job j WHERE j.id = ?`,
      )
      .get(jobId) as JobRow | undefined;
    return row ? this.toJobRecord(row, options.staleAfterMs) : null;
  }

  async listJobs(options: ListJobsOptions = {}): Promise<JobRecord[]> {
    const limit = options.limit ?? 50;
    // Status filter handling: 'STALE' is read-computed, never persisted,
    // so we translate a STALE filter into "RUNNING with old heartbeat" at
    // SQL time. Other statuses match the column directly.
    const status = options.status ?? null;
    const staleAfterMs = options.staleAfterMs;
    const sql = `
      SELECT j.*, (SELECT COUNT(*) FROM event WHERE job_id = j.id) AS event_count
      FROM job j
      WHERE (? IS NULL OR j.name = ?)
        AND (
          ? IS NULL
          OR (? = 'STALE'
              AND j.status = 'RUNNING'
              AND ? IS NOT NULL
              AND j.heartbeat_enabled = 1
              AND (j.heartbeat_at IS NULL OR j.heartbeat_at < datetime('now', ? || ' seconds')))
          OR (? != 'STALE' AND j.status = ?)
        )
      ORDER BY j.created_at DESC
      LIMIT ?
    `;
    const name = options.name ?? null;
    const staleSeconds = staleAfterMs !== undefined ? `-${staleAfterMs / 1000}` : null;
    const staleAfterMsParam = staleAfterMs !== undefined ? staleAfterMs : null;
    const rows = this.db
      .prepare(sql)
      .all(
        name,
        name,
        status,
        status,
        staleAfterMsParam,
        staleSeconds,
        status,
        status,
        limit,
      ) as JobRow[];
    return rows.map((r) => this.toJobRecord(r, staleAfterMs));
  }

  /**
   * Translate a row to a JobRecord, computing the read-time STALE status
   * when the caller requested staleness detection and this row qualifies.
   * The persisted `status` column is never modified by reads.
   */
  private toJobRecord(row: JobRow, staleAfterMs?: number): JobRecord {
    const persistedStatus = row.status;
    const heartbeatAt = parseDate(row.heartbeat_at);
    let status: JobStatus = persistedStatus;
    if (
      staleAfterMs !== undefined &&
      persistedStatus === 'RUNNING' &&
      row.heartbeat_enabled === 1 &&
      (!heartbeatAt || Date.now() - heartbeatAt.getTime() > staleAfterMs)
    ) {
      status = 'STALE';
    }
    return {
      id: row.id,
      name: row.name,
      input: JSON.parse(row.input),
      status,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      eventCount: row.event_count,
      createdAt: parseDate(row.created_at)!,
      startedAt: parseDate(row.started_at),
      completedAt: parseDate(row.completed_at),
      sessionId: row.session_id ?? undefined,
      pid: row.pid ?? undefined,
      ppid: row.ppid ?? undefined,
      cwd: row.cwd ?? undefined,
      hostname: row.hostname ?? undefined,
      ownerId: row.owner_id ?? undefined,
      launchSource: row.launch_source ?? undefined,
      heartbeatEnabled: row.heartbeat_enabled === 1,
      heartbeatAt: heartbeatAt ?? undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Events — append-only log, resumable via afterId
  // -------------------------------------------------------------------------

  async appendEvent(jobId: string, event: PipelineEvent): Promise<number> {
    const result = this.db
      .prepare(`INSERT INTO event (job_id, event_type, data) VALUES (?, ?, ?)`)
      .run(jobId, event.type, JSON.stringify(event));
    return Number(result.lastInsertRowid);
  }

  async getEvents(jobId: string, afterId: number = 0): Promise<EventRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, event_type, data, created_at
         FROM event WHERE job_id = ? AND id > ? ORDER BY id ASC`,
      )
      .all(jobId, afterId) as EventRow[];
    return rows.map((row) => this.toEventRecord(row));
  }

  private toEventRecord(row: EventRow): EventRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      eventType: row.event_type,
      data: JSON.parse(row.data) as PipelineEvent,
      createdAt: parseDate(row.created_at)!,
    };
  }

  close(): void {
    this.db.close();
  }
}
