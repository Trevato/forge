/**
 * The `stages` source: items entering each stage from issue to live, read
 * from issue, run and pull with no table of its own. With seeded rows the
 * counts are exact, per stage and per hour, and a repo scope narrows them.
 */
import { beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { runQuery, type Scope } from "../src/boards/query.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

let db: Database;
const ALL: Scope = { repoIds: "all" };
const count = (q: Record<string, unknown>, scope: Scope = ALL) => runQuery(db, { source: "stages", aggregate: "count", ...q }, scope);

beforeAll(() => {
  db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u','u@x','x')");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1','u1','one'), ('r2','u1','two')");
  const issue = db.prepare("INSERT INTO issue (id, repo_id, number, kind, title, author_id, created_at) VALUES (?, ?, ?, ?, 't', 'u1', ?)");
  const pull = db.prepare("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?, ?, 'h', 'o', 'o', ?)");
  const run = db.prepare(
    "INSERT INTO run (id, repo_id, kind, issue_id, env, reason, state, started_at, serving_at) VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?)",
  );
  // r1: two issues opened in the 10:00 hour, one in 11:00.
  issue.run("i1", "r1", 1, "issue", "2026-10-01T10:05:00.000Z");
  issue.run("i2", "r1", 2, "issue", "2026-10-01T10:55:00.000Z");
  issue.run("i3", "r1", 3, "issue", "2026-10-01T11:00:00.000Z");
  // A builder starts on i1 twice (a retry) and on i2 once: two items start, at their first start.
  run.run("a1", "r1", "agent", "i1", "", "", "2026-10-01T11:10:00.000Z", null);
  run.run("a2", "r1", "agent", "i1", "", "", "2026-10-01T12:30:00.000Z", null);
  run.run("a3", "r1", "agent", "i2", "", "", "2026-10-01T11:20:00.000Z", null);
  // Queued, never started; a review run; a check: none of them is a start.
  run.run("a4", "r1", "agent", "i3", "", "", null, null);
  run.run("a5", "r1", "agent", "i1", "", "review", "2026-10-01T11:40:00.000Z", null);
  run.run("c1", "r1", "check", "i1", "", "", "2026-10-01T11:45:00.000Z", null);
  // Two pulls open at 12:xx; p1 merges into main, p2 into another branch (not a landing), p3 stays open.
  issue.run("p1", "r1", 4, "pull", "2026-10-01T12:00:00.000Z");
  issue.run("p2", "r1", 5, "pull", "2026-10-01T12:15:00.000Z");
  issue.run("p3", "r1", 6, "pull", "2026-10-01T13:05:00.000Z");
  pull.run("p1", "main", "2026-10-01T13:10:00.000Z");
  pull.run("p2", "side", "2026-10-01T13:20:00.000Z");
  pull.run("p3", "main", null);
  // One production deploy serves at 13:30; a preview's and one never served are not live.
  run.run("d1", "r1", "deploy", null, "production", "", "2026-10-01T13:25:00.000Z", "2026-10-01T13:30:00.000Z");
  run.run("d2", "r1", "deploy", null, "preview-4", "", "2026-10-01T13:25:00.000Z", "2026-10-01T13:31:00.000Z");
  run.run("d3", "r1", "deploy", null, "production", "", "2026-10-01T13:40:00.000Z", null);
  // r2: one issue and one live deploy, in other hours.
  issue.run("j1", "r2", 1, "issue", "2026-10-01T09:00:00.000Z");
  run.run("e1", "r2", "deploy", null, "production", "", "2026-10-01T14:00:00.000Z", "2026-10-01T14:05:00.000Z");
});

test("counts each stage exactly", () => {
  expect(count({ groupBy: "stage" })).toEqual({
    ok: true,
    rows: [
      { group: "1 issue", value: 4 },
      { group: "2 run", value: 2 },
      { group: "3 pull", value: 3 },
      { group: "4 merged", value: 1 },
      { group: "5 live", value: 2 },
    ],
  });
});

test("counts each stage per hour, at the moment it entered", () => {
  expect(count({ groupBy: { bucket: "hour" }, series: "stage" }, { repoIds: ["r1"] })).toEqual({
    ok: true,
    rows: [
      { group: "2026-10-01T10:00:00Z", series: "1 issue", value: 2 },
      { group: "2026-10-01T11:00:00Z", series: "1 issue", value: 1 },
      { group: "2026-10-01T11:00:00Z", series: "2 run", value: 2 },
      { group: "2026-10-01T12:00:00Z", series: "3 pull", value: 2 },
      { group: "2026-10-01T13:00:00Z", series: "3 pull", value: 1 },
      { group: "2026-10-01T13:00:00Z", series: "4 merged", value: 1 },
      { group: "2026-10-01T13:00:00Z", series: "5 live", value: 1 },
    ],
  });
});

test("a repo scope and a range narrow it", () => {
  expect(count({ groupBy: "stage" }, { repoIds: ["r2"] })).toEqual({
    ok: true,
    rows: [{ group: "1 issue", value: 1 }, { group: "5 live", value: 1 }],
  });
  // The retry at 12:30 is not a start: i1 entered at 11:10, outside this range.
  expect(count({ from: "2026-10-01T12:00:00Z", to: "2026-10-01T13:00:00Z", groupBy: "stage" })).toEqual({
    ok: true,
    rows: [{ group: "3 pull", value: 2 }],
  });
  expect(count({ filter: [{ column: "stage", op: "eq", value: "5 live" }] })).toEqual({ ok: true, rows: [{ group: null, value: 2 }] });
});

test("answers on a fresh forge", () => {
  const fresh = openDb(":memory:", migrations);
  expect(runQuery(fresh, { source: "stages", aggregate: "count", groupBy: "stage" }, ALL)).toEqual({ ok: true, rows: [] });
});
