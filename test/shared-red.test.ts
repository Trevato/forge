/**
 * A red many pulls share (#2266), on in-memory SQLite: a test failed by
 * three pulls in the hour is the lane's, one failed by fewer, or failed
 * longer ago, is the pull's own; the vitals carry one card per shared test,
 * linked to its flake issue once the sentinel has filed one.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { claimRun, createRun, finishRun, type Run } from "../src/core/runs.ts";
import {
  SHARED_PULLS,
  SHARED_WINDOW_MS,
  TREE_GATES,
  flakeHref,
  flakeKey,
  sharedCause,
  sharedTests,
  sharedWithPulls,
} from "../src/checks/shared_red.ts";
import { budgetBreaches, keyPart } from "../src/crew/sentinel.ts";
import { id, idFloor } from "../src/kernel/id.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { ErrorLedger } from "../src/kernel/log.ts";
import { RefusedLedger } from "../src/kernel/internal_refused.ts";

let db: Database;
beforeEach(() => {
  db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'trevato', 't@x', '')");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'forge')");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r2', 'u1', 'other')");
  for (let i = 1; i <= 6; i++)
    db.run(
      `INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('i${i}', 'r1', ${i}, 'pull', 'p', 'u1')`,
    );
  db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('j1', 'r2', 1, 'pull', 'p', 'u1')");
});

const red = (issueId: string, names: string[], repoId = "r1"): Run => {
  const run = createRun(db, { repoId, kind: "check", env: `pull-${issueId}`, issueId, commitOid: "a".repeat(40), reason: "push" });
  claimRun(db, run.id);
  return finishRun(db, run.id, { state: "failed", summary: "check failed", checkDetail: { passed: 1, failed: names.length, names } })!;
};
const shared = (run: Run | undefined, now?: number) => sharedWithPulls(db, run, now);

describe("a red many pulls share", () => {
  test("three pulls on one test share it; two do not", () => {
    red("i1", ["X"]);
    const second = red("i2", ["X"]);
    expect(shared(second)).toBe(false);
    const third = red("i3", ["X"]);
    expect(SHARED_PULLS).toBe(3);
    expect(shared(third)).toBe(true);
    expect(shared(second)).toBe(true);
  });

  test("bun's (unnamed) label is no test: unrelated pulls sharing it are not the lane's", () => {
    for (const i of ["i1", "i2", "i3"]) red(i, ["(unnamed)"]);
    expect(shared(red("i4", ["(unnamed)"]))).toBe(false);
    expect(sharedTests(db)).toEqual([]);
  });

  test("a gate on the tree is each pull's own red, however many trip it (#2868)", () => {
    const gate = "design check: nothing added outside the system (#2678) > the tree is no worse than its baseline";
    for (const i of ["i1", "i2", "i3"]) red(i, [gate]);
    expect(shared(red("i4", [gate]))).toBe(false);
    expect(shared(red("i5", [gate, "X"]))).toBe(false);
    expect(sharedTests(db)).toEqual([]);
  });

  test("every tree gate names a suite that exists", () => {
    const suites = new Set<string>();
    for (const f of new Glob("test/*.test.ts").scanSync("."))
      for (const m of readFileSync(f, "utf8").matchAll(/describe\("((?:[^"\\]|\\.)*)"/g)) suites.add(`${m[1]} > `);
    for (const g of TREE_GATES) expect(suites.has(g)).toBe(true);
  });

  test("one pull red three times is its own red, not the lane's", () => {
    red("i1", ["X"]);
    red("i1", ["X"]);
    expect(shared(red("i1", ["X"]))).toBe(false);
  });

  test("every test the check names must be shared; naming none is the pull's own", () => {
    for (const i of ["i1", "i2", "i3"]) red(i, ["X"]);
    expect(shared(red("i4", ["X", "Y"]))).toBe(false);
    expect(shared(red("i5", ["Y"]))).toBe(false);
    expect(shared(red("i6", []))).toBe(false);
    expect(shared(undefined)).toBe(false);
  });

  test("another repository's reds, main's own, and reds older than the hour count for nothing", () => {
    red("j1", ["X"], "r2");
    const main = createRun(db, { repoId: "r1", kind: "check", env: "main", commitOid: "b".repeat(40), reason: "push" });
    claimRun(db, main.id);
    finishRun(db, main.id, { state: "failed", summary: "check failed", checkDetail: { passed: 1, failed: 1, names: ["X"] } });
    red("i1", ["X"]);
    expect(shared(red("i2", ["X"]))).toBe(false);
    const third = red("i3", ["X"]);
    expect(shared(third)).toBe(true);
    expect(shared(third, Date.now() + SHARED_WINDOW_MS + 1_000)).toBe(false);
  });

  test("a check detail that is not JSON is skipped, not thrown on", () => {
    for (const i of ["i1", "i2"]) red(i, ["X"]);
    const broken = red("i3", ["X"]);
    db.run("UPDATE run SET check_detail = '{not json' WHERE id = ?1", [broken.id]);
    expect(shared(red("i4", ["X"]))).toBe(true);
    expect(sharedTests(db)[0]!.pulls).toBe(3);
  });

  test("the vitals carry one card per shared test, naming it, to file its flake issue", () => {
    for (const i of ["i1", "i2", "i3", "i4"]) red(i, ["X", "Y"]);
    red("i5", ["Z"]);
    const v = vitals({ db, dataDir: tmpdir(), signals: { errors: new ErrorLedger(), refused: new RefusedLedger() } });
    const cards = v.degraded.filter((d) => d.cause.startsWith("shared:"));
    expect(cards.map((c) => c.cause).sort()).toEqual(
      [sharedCause({ repoId: "r1", test: "X" }), sharedCause({ repoId: "r1", test: "Y" })].sort(),
    );
    expect(cards.find((c) => c.cause === sharedCause({ repoId: "r1", test: "X" }))!.sentence).toBe(
      `trevato/forge: "X" failed on 4 pulls in the last hour — the lane's red, not theirs; they wait for main's next green check, unparked.`,
    );
    expect(cards[0]!.href).toBe("/trevato/forge/issues/new");
  });

  test("once the sentinel files the flake issue, the card follows it; closed, it files again", () => {
    for (const i of ["i1", "i2", "i3"]) red(i, ["X"]);
    const [t] = sharedTests(db);
    db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('f1', 'r2', 9, 'issue', 'flake', 'u1')");
    db.run(
      "INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES (?1, 'f1', '', 'x', 'x')",
      [flakeKey(sharedCause(t!))],
    );
    expect(flakeHref(db, t!)).toBe("/trevato/other/issues/9");
    db.run("UPDATE issue SET state = 'closed' WHERE id = 'f1'");
    expect(flakeHref(db, t!)).toBe("/trevato/forge/issues/new");
  });

  test("the cause is the sentinel's key, whole, and a breach it files at once", () => {
    const cause = sharedCause({ repoId: "01m23vygyffx5hg2f5vm8r74sr", test: "two forges in one process keep their own error and refusal signals" });
    expect(flakeKey(cause)).toBe(`degraded:${keyPart(cause)}`);
    expect(keyPart(cause)).toBe(cause.replaceAll(":", "-"));
    db.run("INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES (?1, 's', '/x', 1000)", [cause]);
    const [found] = budgetBreaches(db, 2000);
    expect(found!.key).toBe(flakeKey(cause));
    expect(found!.urgent).toBe(true);
  });

  test("an id made at or after a moment sorts at or above its floor", () => {
    const at = Date.now();
    expect(id(at) >= idFloor(at)).toBe(true);
    expect(idFloor(at - 1) < idFloor(at)).toBe(true);
    expect(idFloor(at)).toHaveLength(26);
  });
});
