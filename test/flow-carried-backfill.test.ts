/** Pulls closed as carried before `pull.carried` existed (#8738) are marked by the backfill, and the vitals and home figures leave them out. */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationFiles } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { readKpis } from "../src/flow/kpis.ts";
import { readVitals } from "../src/flow/vitals.ts";

const BACKFILL = "20261102200000-pull-carried-backfill";
const dir = mkdtempSync(join(tmpdir(), "carried-backfill-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;

test("the backfill marks the old carried closes, and only the real landings count", () => {
  const at = migrationFiles.findIndex((m) => m.name === BACKFILL);
  expect(at).toBeGreaterThan(0);
  const path = join(dir, "forge.db");
  const before = openDb(path, migrationFiles.slice(0, at));
  before.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u', 'u', 'u@x', 'x')");
  before.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r', 'u', 'r', 'public')");
  const branch = before.query<{ b: string }, []>("SELECT default_branch AS b FROM repo WHERE id = 'r'").get()!.b;
  const now = Date.now();
  let n = 0;
  const pull = (mergedOid: string | null, baseOid: string, ago: number | null): void => {
    n++;
    before.run(
      "INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, 'r', ?2, 'pull', 'p', 'u', 'closed')",
      [`p${n}`, n],
    );
    before.run(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      [`p${n}`, branch, `b${n}`, baseOid, `head${n}`, ago === null ? null : new Date(now - ago).toISOString(), mergedOid],
    );
  };
  // Two real landings: each wrote its own commit on the base it found.
  pull("land1", "base1", 10 * MIN);
  pull("land2", "base2", 20 * MIN);
  // Three carried closes, as `closeAsMerged` recorded them before 4e481725: the base it found as the merged commit.
  for (let i = 0; i < 3; i++) pull(`tip${i}`, `tip${i}`, (30 + i) * MIN);
  // An imported merged pull has no merged commit; an unmerged pull none either. Neither is touched.
  pull(null, "", 120 * MIN);
  pull(null, "base9", null);
  before.close();

  const db = openDb(path, migrationFiles);
  const marked = db.query<{ id: string }, []>("SELECT issue_id AS id FROM pull WHERE carried = 1 ORDER BY issue_id").all();
  expect(marked.map((r) => r.id)).toEqual(["p3", "p4", "p5"]);
  const vitals = readVitals(db, new Date(now));
  expect(vitals.landed1h).toBe(2);
  // The import counts in six hours, as it did before: it is not a carried close.
  expect(vitals.landed6h).toBe(3);
  expect(readKpis(db, new Date(now)).landed).toBe(2);
  db.close();
});
