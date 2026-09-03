/**
 * SQLite, opened the one correct way, with linear numbered migrations.
 * The database is an index over truth that lives in git — losing it should
 * always be survivable, corrupting it silently should be impossible.
 */

import { Database } from "bun:sqlite";
import { defect } from "./error.ts";

/**
 * How long a writer waits for another writer before giving up. Long by
 * ordinary standards on purpose: the forge is one process, so contention is
 * a burst of concurrent agents rather than a stuck peer, and a burst is over
 * in milliseconds. Failing a request that would have succeeded after a 3ms
 * wait is the worse outcome by a wide margin.
 */
const BUSY_TIMEOUT_MS = 15_000;

/**
 * Pages the index keeps hot. Negative means KiB rather than pages, so this
 * is 64 MiB regardless of page size — enough to hold the b-trees a busy
 * forge walks on every request (repo, issue, comment) without re-reading
 * them, and small enough to be unremarkable on any machine that runs git.
 */
const CACHE_KIB = 64 * 1024;

/**
 * Map the database file instead of read()ing it. Reads become page-cache
 * hits with no syscall; a database larger than this simply falls back to
 * normal I/O beyond the mapped prefix, so the number is a ceiling and not a
 * commitment.
 */
const MMAP_BYTES = 512 * 1024 * 1024;

export function openDb(path: string, migrations: readonly string[]): Database {
  const db = new Database(path, { create: true, strict: true });
  applyPragmas(db);
  migrate(db, migrations);
  return db;
}

/**
 * The pragmas, in one place and applied before anything else touches the
 * handle. `journal_mode` and `foreign_keys` are correctness; the rest are
 * the difference between a forge that shrugs at two hundred agents and one
 * that spends its life in `fsync`.
 */
export function applyPragmas(db: Database): void {
  // Readers never block the writer and the writer never blocks readers —
  // the only journal mode in which a busy forge is a pleasant place to be.
  db.exec("PRAGMA journal_mode = WAL");
  // Under WAL, NORMAL means a commit is durable across a process crash and
  // may lose the last transactions only in a power cut. That is the right
  // trade for an index that git can rebuild.
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA cache_size = -${CACHE_KIB}`);
  db.exec(`PRAGMA mmap_size = ${MMAP_BYTES}`);
  // Temp b-trees (the ORDER BY a query cannot get from an index) belong in
  // memory; spilling them to disk is how a list page acquires a mystery
  // hundred milliseconds.
  db.exec("PRAGMA temp_store = MEMORY");
  // Checkpoint at ~4 MiB of WAL rather than the 1000-page default: fewer,
  // larger checkpoints, and a WAL that cannot grow without bound.
  db.exec("PRAGMA wal_autocheckpoint = 1000");
}

/**
 * Run a write, retrying the one failure that is not a failure.
 *
 * `SQLITE_BUSY` means "another writer holds the lock", which is a scheduling
 * fact, not an error the caller did anything about — and it must never reach
 * an agent as a 500. `busy_timeout` handles almost all of it inside SQLite;
 * this is the backstop for the case it cannot handle (a busy *snapshot*
 * inside an already-open transaction, where SQLite refuses to wait at all).
 *
 * Bounded, and short: five tries with a few milliseconds of jitter between
 * them. Anything a longer retry would fix is a deadlock, and a deadlock
 * should surface rather than be waited out.
 */
export function withRetry<T>(work: () => T, attempts = 5): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return work();
    } catch (error) {
      if (!isBusy(error)) throw error;
      lastError = error;
      // Spin briefly. A synchronous sleep is right here: the caller is
      // holding the thread anyway, and yielding would let the *next* writer
      // in ahead of us and turn a wait into a livelock.
      const until = performance.now() + 2 * (attempt + 1);
      while (performance.now() < until) {
        /* wait */
      }
    }
  }
  throw lastError;
}

/**
 * A write transaction with the retry above around it. `BEGIN IMMEDIATE`,
 * not the deferred default: a transaction that starts by reading and later
 * writes can fail to upgrade its lock and must then be retried from the
 * top, which is the one shape where SQLite's own busy handler gives up.
 * Taking the write lock at the start makes contention a wait instead.
 */
export function transact<T>(db: Database, work: () => T): T {
  const tx = db.transaction(work);
  return withRetry(() => tx.immediate());
}

export function isBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === "string" && code.startsWith("SQLITE_BUSY")) ||
    /SQLITE_BUSY|database is locked/i.test(String(error))
  );
}

function migrate(db: Database, migrations: readonly string[]): void {
  const row = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get();
  const applied = row?.user_version ?? 0;
  if (applied > migrations.length) {
    defect(
      "db.future_schema",
      `database is at schema ${applied}, this build only knows ${migrations.length} — refusing to run`,
    );
  }
  for (let i = applied; i < migrations.length; i++) {
    const sql = migrations[i];
    if (!sql) defect("db.migration_missing", `migration ${i + 1} is empty`);
    db.transaction(() => {
      db.exec(sql);
      // PRAGMA can't be parameterized; the value is a loop index, not input.
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
}
