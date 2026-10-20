/**
 * The `app_vital` source: each app's p75 load and INP per day, nearest rank,
 * visible only through the repos a scope names.
 */
import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { runQuery, type Scope } from "../src/boards/query.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

let db: Database;
const q = (scope: Scope, extra: Record<string, unknown> = {}) =>
  runQuery(db, { source: "app_vital", aggregate: "max", column: "load_p75", groupBy: "day", series: "app", ...extra }, scope);

beforeAll(() => {
  db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u','u@x','x'), ('u2','w','w@x','x')");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1','u1','one'), ('r2','u2','two')");
  db.run("INSERT INTO app (id, repo_id, slug, access) VALUES ('a1','r1','one','public'), ('a2','r2','two','public')");
  const put = db.prepare("INSERT INTO app_vital (app_id, day, at, visitor, load, inp) VALUES (?, ?, 0, ?, ?, ?)");
  // a1, day 1: loads 100..400 -> rank ceil(.75*4)=3 -> 300; inp 10,20 -> rank 2 -> 20.
  [100, 200, 300, 400].forEach((l, i) => put.run("a1", "2026-10-01", `v${i}`, l, i < 2 ? (i + 1) * 10 : null));
  // a1, day 2: one report, no inp.
  put.run("a1", "2026-10-02", "v0", 50, null);
  // a2, day 1: five loads -> rank ceil(3.75)=4 -> 40; inp 5.
  [50, 10, 20, 30, 40].forEach((l, i) => put.run("a2", "2026-10-01", `w${i}`, l, i === 0 ? 5 : null));
});

test("each app's p75 per day is the nearest rank", () => {
  const rows = runQuery(db, { source: "app_vital", aggregate: "max", column: "load_p75", groupBy: "day", series: "app" }, { repoIds: "all" });
  expect(rows).toEqual({
    ok: true,
    rows: [
      { group: "2026-10-01T00:00:00.000Z", value: 300, series: "a1" },
      { group: "2026-10-01T00:00:00.000Z", value: 40, series: "a2" },
      { group: "2026-10-02T00:00:00.000Z", value: 50, series: "a1" },
    ],
  });
  const inp = q({ repoIds: "all" }, { column: "inp_p75" });
  expect(inp).toEqual({
    ok: true,
    rows: [
      { group: "2026-10-01T00:00:00.000Z", value: 20, series: "a1" },
      { group: "2026-10-01T00:00:00.000Z", value: 5, series: "a2" },
      { group: "2026-10-02T00:00:00.000Z", value: null, series: "a1" },
    ],
  });
  const n = q({ repoIds: "all" }, { aggregate: "sum", column: "reports" });
  expect(n.ok && n.rows.map((r) => r.value)).toEqual([4, 5, 1]);
});

test("a scope sees only its own repos' apps, and a stranger none", () => {
  const mine = q({ repoIds: ["r2"] });
  expect(mine).toEqual({ ok: true, rows: [{ group: "2026-10-01T00:00:00.000Z", value: 40, series: "a2" }] });
  expect(q({ repoIds: [] })).toEqual({ ok: true, rows: [] });
  expect(q({ repoIds: ["r9"] })).toEqual({ ok: true, rows: [] });
});

test("from and to bound the days", () => {
  const r = q({ repoIds: "all" }, { from: "2026-10-02T00:00:00Z" });
  expect(r.ok && r.rows.length).toBe(1);
});
