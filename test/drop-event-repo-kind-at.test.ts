/**
 * A forge that booted 2295ecb2 carries `event_repo_kind_at`, the first text
 * of a migration later edited; the next boot drops it and keeps the partial
 * index that replaced it (#8353). On a fresh database the drop is a no-op.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/kernel/db.ts";
import { migrationFiles, migrations } from "../src/core/schema.ts";

const root = mkdtempSync(join(tmpdir(), "forge-drop-index-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const DROP = "20261102160000-drop-event-repo-kind-at";

const indexes = (db: Database): string[] =>
  db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event'")
    .all()
    .map((r) => r.name);

test("a database carrying the old index loses it on the next boot", () => {
  expect(migrationFiles.some((m) => m.name === DROP)).toBe(true);
  const path = join(root, "booted-2295ecb2.db");
  const before = migrationFiles.filter((m) => m.name !== DROP).map((m) => m.sql);
  const old = openDb(path, before);
  old.exec("CREATE INDEX event_repo_kind_at ON event(repo_id, kind, created_at)");
  expect(indexes(old)).toContain("event_repo_kind_at");
  old.close();

  const db = openDb(path, migrations);
  expect(indexes(db)).not.toContain("event_repo_kind_at");
  expect(indexes(db)).toContain("event_repo_pull_closed_at");
  db.close();
});

test("on a fresh database the drop is a no-op", () => {
  const db = openDb(join(root, "fresh.db"), migrations);
  expect(indexes(db)).not.toContain("event_repo_kind_at");
  expect(indexes(db)).toContain("event_repo_pull_closed_at");
  db.close();
});
