/**
 * Thin driver over the Node built-in `node:sqlite`, exposing the surface
 * `SqliteJobStore` was written against when it used better-sqlite3
 * (prepare/exec/close plus `pragma()` and `transaction()` conveniences).
 *
 * Why this exists: better-sqlite3 is an ABI-pinned native addon — every Node
 * major bump breaks installs until a prebuilt binary ships, and source builds
 * fail outright against brand-new V8 headers. The built-in module removes
 * that entire failure class. Node >=22.5 is required; on the 22.x line the
 * module emits an ExperimentalWarning (it is stable from Node 23.4 onward),
 * which is cosmetic — the API surface used here is unchanged across those
 * versions.
 *
 * Only the methods the store uses are exposed. This is an @internal module,
 * not part of the public API.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** @internal */
export class SqliteDriver {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }

  /**
   * better-sqlite3-compatible pragma helper. Assignments (`journal_mode =
   * WAL`) execute and return undefined; reads return the first column of the
   * first row when `{ simple: true }`, else the whole row.
   */
  pragma(stmt: string, opts?: { simple?: boolean }): unknown {
    if (stmt.includes('=')) {
      this.db.exec(`PRAGMA ${stmt}`);
      return undefined;
    }
    const row = this.db.prepare(`PRAGMA ${stmt}`).get() as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return opts?.simple ? Object.values(row)[0] : row;
  }

  /**
   * better-sqlite3-compatible transaction wrapper: returns a function that
   * runs `fn` inside BEGIN…COMMIT, rolling back on throw. Like the original,
   * the transaction starts deferred and upgrades to a write lock at the
   * first write, which is what serializes concurrent acquireExclusive calls.
   */
  transaction<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => TReturn,
  ): (...args: TArgs) => TReturn {
    return (...args: TArgs): TReturn => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // The connection may already have rolled back (e.g. on close).
        }
        throw err;
      }
    };
  }
}
