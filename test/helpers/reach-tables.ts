import type { Database } from "bun:sqlite";

/** The three tables `readReach` reads, bare, for tests that build their own small database. */
export function reachTables(db: Database): void {
  db.run("CREATE TABLE session (user_id TEXT, last_seen_at TEXT)");
  db.run("CREATE TABLE user (id TEXT)");
  db.run("CREATE TABLE page_vital (day TEXT, visitor TEXT, load REAL, inp REAL)");
}
