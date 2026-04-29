/**
 * sqlite-backed JobStore implementation — the bundled default.
 *
 * Two tables (job, event) on a single sqlite file. WAL journal for write
 * concurrency, foreign keys enforced. Synchronous (better-sqlite3) — fast
 * and simple for this access pattern.
 */

import Database, { type Database as DB } from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { PipelineEvent } from '../phase.js';
import type {
  EventRecord,
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

  createJob(name: string, input: unknown): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO job (id, name, input) VALUES (?, ?, ?)`)
      .run(id, name, JSON.stringify(input));
    return id;
  }

  setRunning(jobId: string): void {
    this.db
      .prepare(`UPDATE job SET status = 'RUNNING', started_at = datetime('now') WHERE id = ?`)
      .run(jobId);
  }

  setCompleted(jobId: string, result: unknown): void {
    this.db
      .prepare(
        `UPDATE job SET status = 'COMPLETED', result = ?, completed_at = datetime('now') WHERE id = ?`,
      )
      .run(JSON.stringify(result ?? null), jobId);
  }

  setFailed(jobId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE job SET status = 'FAILED', error = ?, completed_at = datetime('now') WHERE id = ?`,
      )
      .run(error, jobId);
  }

  // -------------------------------------------------------------------------
  // Job reads
  // -------------------------------------------------------------------------

  getJob(jobId: string): JobRecord | null {
    const row = this.db
      .prepare(
        `SELECT j.*, (SELECT COUNT(*) FROM event WHERE job_id = j.id) AS event_count
         FROM job j WHERE j.id = ?`,
      )
      .get(jobId) as JobRow | undefined;
    return row ? this.toJobRecord(row) : null;
  }

  listJobs(options: ListJobsOptions = {}): JobRecord[] {
    const limit = options.limit ?? 50;
    // Build one parameterized query — `name IS NULL OR j.name = name` lets a
    // null parameter act as a no-filter wildcard, removing the duplicated
    // SELECT/ORDER/LIMIT clauses that were previously copied per branch.
    const sql = `
      SELECT j.*, (SELECT COUNT(*) FROM event WHERE job_id = j.id) AS event_count
      FROM job j
      WHERE (? IS NULL OR j.name = ?)
      ORDER BY j.created_at DESC
      LIMIT ?
    `;
    const name = options.name ?? null;
    const rows = this.db.prepare(sql).all(name, name, limit) as JobRow[];
    return rows.map((r) => this.toJobRecord(r));
  }

  private toJobRecord(row: JobRow): JobRecord {
    return {
      id: row.id,
      name: row.name,
      input: JSON.parse(row.input),
      status: row.status,
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      eventCount: row.event_count,
      createdAt: parseDate(row.created_at)!,
      startedAt: parseDate(row.started_at),
      completedAt: parseDate(row.completed_at),
    };
  }

  // -------------------------------------------------------------------------
  // Events — append-only log, resumable via afterId
  // -------------------------------------------------------------------------

  appendEvent(jobId: string, event: PipelineEvent): number {
    const result = this.db
      .prepare(`INSERT INTO event (job_id, event_type, data) VALUES (?, ?, ?)`)
      .run(jobId, event.type, JSON.stringify(event));
    return Number(result.lastInsertRowid);
  }

  getEvents(jobId: string, afterId: number = 0): EventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, job_id, event_type, data, created_at
         FROM event WHERE job_id = ? AND id > ? ORDER BY id ASC`,
      )
      .all(jobId, afterId) as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      eventType: r.event_type,
      data: JSON.parse(r.data) as PipelineEvent,
      createdAt: parseDate(r.created_at)!,
    }));
  }

  close(): void {
    this.db.close();
  }
}
