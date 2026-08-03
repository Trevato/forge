/**
 * SQLite, opened the one correct way, with linear numbered migrations.
 * The database is an index over truth that lives in git — losing it should
 * always be survivable, corrupting it silently should be impossible.
 */

import { Database } from "bun:sqlite";
import { defect } from "./error.ts";

export function openDb(path: string, migrations: readonly string[]): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, migrations);
  return db;
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
