import type { Database } from "bun:sqlite";

/** The three tables `readReach` reads, bare, for tests that build their own small database. */
export function reachTables(db: Database): void {
  db.run("CREATE TABLE session (user_id TEXT, last_seen_at TEXT)");
  db.run("CREATE TABLE user (id TEXT)");
  db.run("CREATE TABLE page_vital (day TEXT, visitor TEXT, load REAL, inp REAL)");
}

/** The tables `countBugs` reads, bare, beside a small `issue` table of the test's own. */
export function bugTables(db: Database): void {
  db.run("CREATE TABLE issue_label (issue_id TEXT, label_id TEXT)");
  db.run("CREATE TABLE label (id TEXT, name TEXT)");
}
