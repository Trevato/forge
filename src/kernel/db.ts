/**
 * SQLite, opened the one correct way, with its migrations applied
 * (`kernel/migrate.ts`).
 * The database is an index over truth that lives in git — losing it should
 * always be survivable, corrupting it silently should be impossible.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLog } from "./log.ts";
import { tightenDbFiles } from "./file_modes.ts";
import { type Migration, migrate } from "./migrate.ts";

const log = createLog("db");

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

/**
 * How many distinct SQL texts each connection keeps prepared (#9514).
 * `db.query` caches its statements, but Bun keeps only the first 20 a
 * connection sees and prepares every later one again on each call; one code
 * page asks about thirty, so a cached page still spent ~1.4 ms of its ~4 ms
 * preparing. The forge's queries are fixed texts (about 2,000 call sites), so
 * this holds every one of them; a text past the cap is prepared per call as
 * before, never wrong. Bun reads it on each `query`, so set once here.
 */
export const QUERY_CACHE = 4096;
(Database as unknown as { MAX_QUERY_CACHE_SIZE: number }).MAX_QUERY_CACHE_SIZE = QUERY_CACHE;

export function openDb(path: string, migrations: readonly Migration[]): Database {
  const memory = path === ":memory:";
  const fresh = memory || !existsSync(path);
  const image = fresh ? migratedEmpty.get(migrations) : undefined;
  let db: Database;
  if (image !== undefined && memory) {
    db = Database.deserialize(rollbackJournal(image), { strict: true });
  } else {
    if (image !== undefined) writeFileSync(path, image, { flag: "wx", mode: 0o600 });
    db = new Database(path, { create: true, strict: true });
  }
  applyPragmas(db);
  // Only files this call made: one that already exists is tightened below if
  // too open (`file_modes.ts`; vitals names any it could not). The umask can widen
  // the mode at creation, so it is set again.
  if (fresh && !memory)
    for (const suffix of ["", "-wal", "-shm"])
      try {
        chmodSync(path + suffix, 0o600);
      } catch {
        // No such file (a journal mode without one): nothing to tighten.
      }
  // On a copy every migration is already recorded, so this is a no-op —
  // and a list that grew since the copy was taken still runs what is new;
  // one behind the copy boots and says what it does not know (#783).
  if (!fresh && !memory) tightenDbFiles(dirname(path));
  const { unknown } = migrate(db, migrations);
  if (unknown.length > 0)
    log.warn("database has migrations this build does not know; left as they are", {
      count: unknown.length,
      unknown: unknown.join(","),
    });
  if (fresh && image === undefined) migratedEmpty.set(migrations, db.serialize());
  return db;
}

/**
 * The empty database each migration list makes, kept by this process after
 * it makes it once: a fresh database after the first is a copy of it, not
 * ninety-odd migrations again. A forge opens one fresh database in its life,
 * so this is the test suite's saving — about 90 ms of every `createApp` — and
 * production never reads a copy. Keyed by the list itself, so a test's own
 * list is never confused with the schema. An empty database is the same
 * bytes however it was made: the migrations that draw randomness only
 * rewrite rows an empty database does not have.
 */
const migratedEmpty = new WeakMap<readonly Migration[], Uint8Array>();

/**
 * The image with its header saying "rollback journal" (bytes 18 and 19 of a
 * SQLite file are the read and write versions: 2 is WAL, 1 legacy), which
 * an in-memory database needs — memory has no write-ahead log to open.
 */
function rollbackJournal(image: Uint8Array): Uint8Array {
  const copy = image.slice();
  copy[18] = 1;
  copy[19] = 1;
  return copy;
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

/**
 * A write not worth the thread (#6957): telemetry that keeps its rows and
 * tries again. `busy_timeout` waits on the one thread every request is
 * served from, so a write behind another process's lock (a draining forge
 * on the same data) stops /healthz with it. Here the lock is tried once and
 * SQLITE_BUSY comes back at once; the handle's own timeout is put back after.
 */
export function withoutWaiting<T>(db: Database, work: () => T): T {
  const was = db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout ?? BUSY_TIMEOUT_MS;
  db.exec("PRAGMA busy_timeout = 0");
  try {
    return work();
  } finally {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(was))}`);
  }
}

export function isBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === "string" && code.startsWith("SQLITE_BUSY")) ||
    /SQLITE_BUSY|database is locked/i.test(String(error))
  );
}
