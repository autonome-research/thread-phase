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

type StatementAllResult = ReturnType<StatementSync['all']>;
type StatementRunResult = ReturnType<StatementSync['run']>;

/** Stable subset of StatementSync used by SqliteJobStore. */
export interface SqliteStatement {
  all(...params: any[]): StatementAllResult;
  get(...params: any[]): StatementAllResult[number] | undefined;
  run(...params: any[]): StatementRunResult;
}

function wrapStatement(statement: StatementSync): SqliteStatement {
  const all = (...params: any[]): StatementAllResult =>
    (statement.all as (...args: any[]) => StatementAllResult)(...params);
  return {
    all,
    // Node 22.5's early node:sqlite implementation can return an object whose
    // projected fields are all null from StatementSync.get() when no row
    // matched. Deriving get from all gives stable undefined-on-no-row behavior
    // across the entire supported Node range.
    get: (...params: any[]) => all(...params)[0],
    run: (...params: any[]): StatementRunResult =>
      (statement.run as (...args: any[]) => StatementRunResult)(...params),
  };
}

interface SqliteTransaction<TArgs extends unknown[], TReturn> {
  (...args: TArgs): TReturn;
  immediate(...args: TArgs): TReturn;
}

/** @internal */
export class SqliteDriver {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // Match the bounded lock waiting previously provided by better-sqlite3.
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  prepare(sql: string): SqliteStatement {
    return wrapStatement(this.db.prepare(sql));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }

  /**
   * better-sqlite3-compatible pragma helper. Assignments (`journal_mode =
   * WAL`) execute and return undefined; `{ simple: true }` returns the first
   * column of the first row, while ordinary reads return every result row.
   */
  pragma(stmt: string, opts?: { simple?: boolean }): unknown {
    if (stmt.includes('=')) {
      this.db.exec(`PRAGMA ${stmt}`);
      return undefined;
    }
    const rows = this.db.prepare(`PRAGMA ${stmt}`).all();
    if (opts?.simple) {
      const row = rows[0] as Record<string, unknown> | undefined;
      return row === undefined ? undefined : Object.values(row)[0];
    }
    return rows;
  }

  /**
   * better-sqlite3-compatible transaction wrapper with both deferred and
   * immediate entry points. Immediate mode acquires the write reservation
   * before a read/modify/write sequence, preventing stale-read lock upgrades
   * across processes.
   */
  transaction<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => TReturn,
  ): SqliteTransaction<TArgs, TReturn> {
    const run = (mode: '' | ' IMMEDIATE', args: TArgs): TReturn => {
      this.db.exec(`BEGIN${mode}`);
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
    const transaction = ((...args: TArgs) => run('', args)) as SqliteTransaction<TArgs, TReturn>;
    transaction.immediate = (...args: TArgs) => run(' IMMEDIATE', args);
    return transaction;
  }
}
