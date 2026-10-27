/**
 * `reviewStats` (#6697): the crew's green pulls awaiting a verdict, the median
 * wait from a head's first passing check to a verdict, and verdicts per
 * reviewer in the window — seeded as rows in a fresh database.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { reviewStats } from "../src/core/review-stats.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
const SINCE = at(-60 * MIN);
const oid = (c: string) => c.repeat(40);

let db: Database;
let n = 0;

beforeEach(() => {
  db = openDb(":memory:", migrations);
  db.run("PRAGMA foreign_keys = OFF");
  n = 0;
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r', 'x', 'r')");
  for (const [id, agent] of [["ann", 1], ["bo", 1], ["cy", 1], ["pat", 0]] as const)
    db.query("INSERT INTO user (id, username, email, password_hash, is_agent) VALUES (?1, ?1, ?1 || '@x', 'h', ?2)").run(id, agent);
});

/** An open pull by `author` whose head is `head`; returns its issue id. */
function pull(author: string, head: string, o: { merged?: boolean; repo?: string } = {}): string {
  const id = `i${++n}`;
  db.query("INSERT INTO issue (id, repo_id, number, title, author_id, state) VALUES (?1, ?2, ?3, 't', ?4, 'open')").run(id, o.repo ?? "r", n, author);
  db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', 'b', ?2, ?3, ?4)").run(
    id, oid("0"), head, o.merged ? at(0) : null,
  );
  return id;
}
function run(issue: string, head: string, state: string, finished: number, kind = "check") {
  db.query("INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state, finished_at) VALUES (?1, 'r', ?2, ?3, ?4, ?5, ?6)").run(
    `u${++n}`, kind, issue, head, state, at(finished),
  );
}
function review(issue: string, head: string, by: string, state: string, when: number) {
  db.query("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
    `v${++n}`, issue, by, state, head, at(when),
  );
}

describe("awaiting", () => {
  test("counts an open agent pull with a green head and no verdict", () => {
    const a = pull("ann", oid("a"));
    run(a, oid("a"), "ok", 0);
    expect(reviewStats(db, "r", SINCE).awaiting).toBe(1);
  });

  test("not a person's pull, a red or unchecked head, or a merged pull", () => {
    const person = pull("pat", oid("a"));
    run(person, oid("a"), "ok", 0);
    const red = pull("ann", oid("b"));
    run(red, oid("b"), "ok", 0);
    run(red, oid("b"), "failed", 1);
    const running = pull("ann", oid("c"));
    run(running, oid("c"), "running", 0);
    pull("ann", oid("d"));
    const merged = pull("ann", oid("e"), { merged: true });
    run(merged, oid("e"), "ok", 0);
    expect(reviewStats(db, "r", SINCE).awaiting).toBe(0);
  });

  test("a verdict on the head takes it out; a comment does not", () => {
    const a = pull("ann", oid("a"));
    run(a, oid("a"), "ok", 0);
    review(a, oid("a"), "bo", "commented", 5 * MIN);
    expect(reviewStats(db, "r", SINCE).awaiting).toBe(1);
    review(a, oid("a"), "bo", "approved", 6 * MIN);
    expect(reviewStats(db, "r", SINCE).awaiting).toBe(0);
  });

  test("a verdict on an older head leaves the new green head waiting", () => {
    const a = pull("ann", oid("b"));
    run(a, oid("a"), "ok", 0);
    review(a, oid("a"), "bo", "changes_requested", MIN);
    run(a, oid("b"), "ok", 2 * MIN);
    expect(reviewStats(db, "r", SINCE).awaiting).toBe(1);
  });

  test("a deploy run counts like a check, and another repository's pulls do not", () => {
    const a = pull("ann", oid("a"));
    run(a, oid("a"), "ok", 0, "deploy");
    db.run("INSERT INTO repo (id, owner_id, name) VALUES ('s', 'x', 's')");
    const other = pull("ann", oid("b"), { repo: "s" });
    run(other, oid("b"), "ok", 0);
    expect(reviewStats(db, "r", SINCE).awaiting).toBe(1);
  });
});

describe("latencyMs", () => {
  test("null with no verdict in the window", () => {
    expect(reviewStats(db, "r", SINCE).latencyMs).toBeNull();
    const a = pull("ann", oid("a"));
    run(a, oid("a"), "ok", -200 * MIN);
    review(a, oid("a"), "bo", "approved", -100 * MIN);
    expect(reviewStats(db, "r", SINCE).latencyMs).toBeNull();
  });

  test("odd count: the middle wait, from the first passing check", () => {
    for (const [wait, head] of [[10, "a"], [30, "b"], [20, "c"]] as const) {
      const p = pull("ann", oid(head));
      run(p, oid(head), "failed", -50 * MIN);
      run(p, oid(head), "ok", -40 * MIN);
      run(p, oid(head), "ok", -30 * MIN); // a later pass does not move the start
      review(p, oid(head), "bo", "approved", -40 * MIN + wait * MIN);
    }
    expect(reviewStats(db, "r", SINCE).latencyMs).toBeCloseTo(20 * MIN, -2);
  });

  test("even count: the mean of the two middle waits", () => {
    for (const [wait, head] of [[10, "a"], [20, "b"], [30, "c"], [100, "d"]] as const) {
      const p = pull("ann", oid(head));
      run(p, oid(head), "ok", -50 * MIN);
      review(p, oid(head), "bo", "approved", -50 * MIN + wait * MIN);
    }
    expect(reviewStats(db, "r", SINCE).latencyMs).toBeCloseTo(25 * MIN, -2);
  });

  test("a person's review, a comment, and a review with no passing check are not waits", () => {
    const a = pull("ann", oid("a"));
    run(a, oid("a"), "ok", -50 * MIN);
    review(a, oid("a"), "pat", "approved", -10 * MIN);
    review(a, oid("a"), "bo", "commented", -20 * MIN);
    const b = pull("ann", oid("b"));
    run(b, oid("b"), "failed", -50 * MIN);
    review(b, oid("b"), "bo", "approved", -10 * MIN);
    expect(reviewStats(db, "r", SINCE).latencyMs).toBeNull();
  });
});

describe("byReviewer", () => {
  test("counts verdicts since `since`, most first, ties by name, never a person's", () => {
    const a = pull("ann", oid("a"));
    run(a, oid("a"), "ok", -50 * MIN);
    review(a, oid("a"), "cy", "approved", -40 * MIN);
    review(a, oid("a"), "bo", "changes_requested", -30 * MIN);
    review(a, oid("a"), "bo", "approved", -20 * MIN);
    review(a, oid("a"), "ann", "approved", -10 * MIN);
    review(a, oid("a"), "pat", "approved", -10 * MIN);
    review(a, oid("a"), "cy", "approved", -300 * MIN); // before the window
    expect(reviewStats(db, "r", SINCE).byReviewer).toEqual([
      { name: "bo", count: 2 },
      { name: "ann", count: 1 },
      { name: "cy", count: 1 },
    ]);
  });

  test("a comment is not a verdict", () => {
    const a = pull("ann", oid("a"));
    review(a, oid("a"), "bo", "commented", -10 * MIN);
    expect(reviewStats(db, "r", SINCE).byReviewer).toEqual([]);
  });
});
