/**
 * The adapter's state: the records it holds and the cursor it pulls from,
 * in one bun:sqlite file under `FORGE_APP_DATA`.
 *
 * A record is keyed by the source's id, so writing it twice is a no-op;
 * `put` says whether this call wrote anything. That is what makes a pull
 * idempotent: a replay finds every record already present.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SourceRecord } from "./source.ts";

export interface Store {
  /** Where the next pull starts; "" before the first. */
  cursor(): string;
  setCursor(cursor: string): void;
  /** Write `record`; `true` when it was new or changed, `false` when held already. */
  put(record: SourceRecord): boolean;
  count(): number;
  /** Run `fn` in one transaction: records and cursor land together or not at all. */
  atomically<T>(fn: () => T): T;
  close(): void;
}

/** Open the store in `dir` (made if missing), or in memory for `":memory:"`. */
export function openStore(dir: string): Store {
  let path = ":memory:";
  if (dir !== ":memory:") {
    mkdirSync(dir, { recursive: true });
    path = join(dir, "adapter.sqlite");
  }
  const db = new Database(path, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS record (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const readCursor = db.query<{ value: string }, []>(
    "SELECT value FROM state WHERE key = 'cursor'",
  );
  const writeCursor = db.query(
    "INSERT INTO state (key, value) VALUES ('cursor', $value) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  // Writes only when the id is new or its body changed; `changes` says which.
  const upsert = db.query(
    "INSERT INTO record (id, body) VALUES ($id, $body) ON CONFLICT(id) DO UPDATE SET body = excluded.body WHERE body <> excluded.body",
  );
  const countRows = db.query<{ n: number }, []>("SELECT count(*) AS n FROM record");
  return {
    cursor: () => readCursor.get()?.value ?? "",
    setCursor: (value) => void writeCursor.run({ value }),
    put: (record) => upsert.run({ id: record.id, body: record.body }).changes > 0,
    count: () => countRows.get()?.n ?? 0,
    atomically: (fn) => db.transaction(fn)(),
    close: () => db.close(),
  };
}
