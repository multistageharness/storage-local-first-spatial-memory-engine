/**
 * Phase 1 / Feature 1.1 — SQLite Concurrency Hardening.
 *
 * Every connection in the system is opened through this module so the
 * pragma discipline (WAL, busy_timeout, synchronous=NORMAL) is applied
 * uniformly, and every mutation transaction is forced through
 * BEGIN IMMEDIATE so writers queue at the OS level instead of failing
 * mid-transaction with SQLITE_BUSY.
 */
import Database from 'better-sqlite3';

export interface ConnectionOptions {
  /** Open the database read-only (reader workers). */
  readonly?: boolean;
  /** busy_timeout in ms. Default 60s per REQ Task 1.1.2. */
  busyTimeoutMs?: number;
}

export interface Connection {
  db: Database.Database;
  /**
   * Task 1.1.3 — run `fn` inside a BEGIN IMMEDIATE transaction.
   * The write lock is acquired up-front, so concurrent writers queue
   * on busy_timeout instead of deadlocking on lock upgrade.
   */
  immediate<T>(fn: () => T): T;
  close(): void;
}

export function openConnection(dbPath: string, opts: ConnectionOptions = {}): Connection {
  const { readonly = false, busyTimeoutMs = 60_000 } = opts;

  const db = new Database(dbPath, { readonly, timeout: busyTimeoutMs });

  // Task 1.1.1 — WAL + synchronous=NORMAL on every connection.
  // (journal_mode is persistent but harmless to re-assert; readonly
  // connections can't change it, so guard.)
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  // Task 1.1.2 — patiently block for write locks instead of erroring.
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  const immediate = <T>(fn: () => T): T => {
    if (readonly) throw new Error('immediate(): connection is read-only');
    return db.transaction(fn).immediate();
  };

  return {
    db,
    immediate,
    close: () => db.close(),
  };
}
