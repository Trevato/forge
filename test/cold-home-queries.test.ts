/**
 * The three queries #7896 rewrote for the indexes answer what the ones they
 * replaced did, on rows built to tell them apart: a note that parks an issue,
 * one that is not the newest, an open issue that is not a pull.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { breakerParked, WAITING_NOTES } from "../src/crew/breaker.ts";
import { pullsByAsk } from "../src/core/asked.ts";
import { readPipeline } from "../src/flow/pipeline.ts";
import { readVitals } from "../src/flow/vitals.ts";
import { id } from "../src/kernel/id.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;
let repoId: string;
beforeAll(async () => {
  f = await snappyFixture({ repos: 2, issuesPerRepo: 3 });
  repoId = f.app.db.query<{ id: string }, []>("SELECT id FROM repo LIMIT 1").get()!.id;
}, 60_000);
afterAll(async () => {
  await f.close();
});

const issue = (kind: string, state: string, n: number): string => {
  const i = id();
  f.app.db
    .query("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, ?4, 't', '', ?5, ?6, ?7)")
    .run(i, repoId, n, kind, f.owner.id, state, new Date().toISOString());
  return i;
};
const note = (issueId: string, body: string, at: string) =>
  f.app.db
    .query("INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .run(id(), issueId, f.owner.id, body, at);

test("breakerParked: parked by its newest note only, open only", () => {
  const parked = issue("issue", "open", 9001);
  note(parked, "hello", "2026-01-01T00:00:00.000Z");
  note(parked, WAITING_NOTES[0], "2026-01-02T00:00:00.000Z");
  const spoken = issue("issue", "open", 9002);
  note(spoken, WAITING_NOTES[0], "2026-01-01T00:00:00.000Z");
  note(spoken, "a person spoke", "2026-01-02T00:00:00.000Z");
  const closed = issue("issue", "closed", 9003);
  note(closed, WAITING_NOTES[1], "2026-01-01T00:00:00.000Z");

  const old = f.app.db
    .query<{ issueId: string; repoId: string; at: string }, string[]>(
      `SELECT issueId, repoId, at FROM (
         SELECT i.id AS issueId, i.repo_id AS repoId, c.body AS body, c.created_at AS at,
                ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY c.created_at DESC, c.id DESC) AS rn
         FROM issue i JOIN comment c ON c.issue_id = i.id
         WHERE i.state = 'open' AND i.repo_id IN (?1)
       ) WHERE rn = 1 AND body IN (?2, ?3, ?4)`,
    )
    .all(repoId, ...WAITING_NOTES);
  const now = breakerParked(f.app.db, [repoId]);
  expect(now).toEqual(old);
  expect(now.map((r) => r.issueId)).toEqual([parked]);
});

test("open pulls: an open issue that is not a pull is not counted, as before", () => {
  const db = f.app.db;
  const count = () => readVitals(db).open;
  const before = count();
  issue("issue", "open", 9101);
  expect(count()).toBe(before);
  const pull = issue("pull", "open", 9102);
  db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', 'b', '', '', ?2)").run(pull, repoId);
  expect(count()).toBe(before + 1);
  const old = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE i.state = 'open' AND p.merged_at IS NULL`,
    )
    .get()!.n;
  expect(count()).toBe(old);
});

test("ready asks: the tally is the old join's, counted by hand", () => {
  const db = f.app.db;
  db.query("UPDATE repo SET autonomy = 'on'").run();
  const ready = () => readPipeline(db).find((s) => s.key === "ready")!.waiting;
  const old = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM issue i JOIN repo r ON r.id = i.repo_id
        WHERE i.kind = 'issue' AND i.state = 'open' AND r.autonomy != 'off'
          AND (r.direction_issue_id IS NULL OR r.direction_issue_id != i.id)
          AND NOT EXISTS (SELECT 1 FROM issue_dependency d JOIN issue b ON b.id = d.blocked_by_id
                           WHERE d.issue_id = i.id AND b.state = 'open')
          AND NOT EXISTS (SELECT 1 FROM run x WHERE x.issue_id = i.id AND x.kind = 'agent'
                           AND x.state IN ('queued','running'))`,
    )
    .get()!.n;
  expect(old).toBeGreaterThan(0);
  expect(ready()).toBe(old);
  db.query("UPDATE repo SET autonomy = 'off'").run();
  expect(ready()).toBe(0);
});

test("pullsByAsk: only pulls that close something are read, and the same ones as reading every body", () => {
  const db = f.app.db;
  const mk = (n: number, body: string) => {
    const i = issue("pull", "open", n);
    db.query("UPDATE issue SET body = ?1 WHERE id = ?2").run(body, i);
    db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', 'b', '', '', ?2)").run(i, repoId);
  };
  mk(9201, "CLOSES #7 and fixes #8");
  mk(9202, "mentions #7 only");
  mk(9203, "Resolved #9");
  const got = pullsByAsk(db, [repoId]);
  const keys = [...got.keys()].filter((k) => /#(7|8|9)$/.test(k)).sort();
  expect(keys).toEqual([`${repoId}#7`, `${repoId}#8`, `${repoId}#9`]);
  expect(got.get(`${repoId}#7`)!.map((p) => p.number)).toEqual([9201]);
});

test("the cold pull reads walk an index, not the table", () => {
  const db = f.app.db;
  const plan = (sql: string, ...args: (string | number)[]) =>
    db.query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join("\n");
  const open = plan(
    `SELECT COUNT(*) FROM issue i JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id
      WHERE i.kind = 'pull' AND i.state = 'open' AND p.merged_at IS NULL`,
  );
  expect(open).not.toMatch(/SCAN (p|pull)\b/);
  const win = plan(
    `SELECT COUNT(*) FROM issue i JOIN pull p ON p.issue_id = i.id
      WHERE i.kind = 'pull' AND i.created_at >= ?1 AND i.created_at <= ?2`,
    "a",
    "b",
  );
  expect(win).toMatch(/issue_created/);
});
