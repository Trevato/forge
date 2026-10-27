/**
 * Review threads: resolving and unresolving round-trip through
 * `threadStates`, a comment on a line whose content changed reads as
 * outdated, the latest verdict per author wins, and comments on one
 * (path, side, line) group into one thread.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import type { Diff } from "../src/git/diff.ts";
import {
  addReviewComment,
  anchorId,
  byAnchor,
  hashLine,
  latestReviewByAuthor,
  listReviewComments,
  resolveThread,
  submitReview,
  threadStates,
  unresolveThread,
  withOutdated,
  type Side,
} from "../src/core/reviews.ts";

let db: Database;

const ins = (sql: string) => db.exec(sql);

beforeEach(() => {
  db = openDb(":memory:", migrations);
  ins("INSERT INTO user (id, username, email, password_hash) VALUES ('ann','ann','a@x','x'),('bob','bob','b@x','x')");
  ins("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r1','ann','r','private')");
  ins("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id) VALUES ('p1','r1',1,'pull','t','','ann')");
});

const comment = (path: string, line: number, content: string, side: Side = "new", authorId = "bob") => {
  const made = addReviewComment(db, {
    pullId: "p1",
    authorId,
    body: "note",
    path,
    line,
    side,
    commitOid: "c1",
    lineHash: hashLine(content),
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
};

const diffOf = (path: string, rows: [number, string][]): Diff => ({
  additions: rows.length,
  deletions: 0,
  files: [
    {
      path,
      hunks: [
        {
          lines: rows.map(([n, content]) => ({
            kind: "add",
            oldNumber: null,
            newNumber: n,
            content,
            noNewline: false,
          })),
        },
      ],
    },
  ] as unknown as Diff["files"],
});

describe("resolving threads", () => {
  const anchor = anchorId("a.ts", "new", 3);

  test("resolve shows resolved, unresolve shows open, resolving twice changes nothing", () => {
    expect(threadStates(db, "p1").size).toBe(0);

    resolveThread(db, "p1", anchor, "ann");
    const resolved = threadStates(db, "p1").get(anchor)!;
    expect(resolved.resolvedBy).toBe("ann");
    expect(resolved.resolvedAt).not.toBeNull();

    resolveThread(db, "p1", anchor, "ann");
    expect(threadStates(db, "p1").size).toBe(1);
    expect(threadStates(db, "p1").get(anchor)!.resolvedBy).toBe("ann");

    const open = unresolveThread(db, "p1", anchor);
    expect(open).toEqual({ anchor, resolvedAt: null, resolvedBy: null });
    expect(threadStates(db, "p1").get(anchor)).toEqual(open);

    resolveThread(db, "p1", anchor, "bob");
    expect(threadStates(db, "p1").get(anchor)!.resolvedBy).toBe("bob");
  });

  test("resolving one thread leaves another open and another pull untouched", () => {
    ins("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id) VALUES ('p2','r1',2,'pull','t','','ann')");
    const other = anchorId("a.ts", "new", 4);
    resolveThread(db, "p1", anchor, "ann");
    expect(threadStates(db, "p1").has(other)).toBe(false);
    expect(threadStates(db, "p2").size).toBe(0);
  });
});

describe("outdated comments", () => {
  test("a comment on a changed line is outdated; on an unchanged line it is not", () => {
    comment("a.ts", 1, "const a = 1;");
    comment("a.ts", 2, "const b = 2;");
    const diff = diffOf("a.ts", [
      [1, "const a = 1;"],
      [2, "const b = 3;"],
    ]);
    const out = withOutdated(listReviewComments(db, "p1"), diff);
    expect(out.map((c) => [c.line, c.outdated])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  test("a line or file gone from the diff reads as outdated", () => {
    comment("a.ts", 9, "x");
    comment("gone.ts", 1, "x");
    const out = withOutdated(listReviewComments(db, "p1"), diffOf("a.ts", [[1, "x"]]));
    expect(out.map((c) => c.outdated)).toEqual([true, true]);
  });
});

describe("latestReviewByAuthor", () => {
  test("returns each author's newest review only", () => {
    const send = (authorId: string, state: "approved" | "changes_requested" | "commented") =>
      submitReview(db, { issueId: "p1", authorId, state, commitOid: "c1" });
    send("bob", "changes_requested");
    send("ann", "commented");
    const last = send("bob", "approved");
    const latest = latestReviewByAuthor(db, "p1");
    expect(latest.size).toBe(2);
    expect(latest.get("bob")!.id).toBe(last.ok ? last.value.id : "");
    expect(latest.get("bob")!.state).toBe("approved");
    expect(latest.get("ann")!.state).toBe("commented");
  });

  test("imported reviews are keyed by origin login, not the connecting user", () => {
    for (const [login, state] of [["x", "approved"], ["y", "changes_requested"]] as const) {
      submitReview(db, {
        issueId: "p1", authorId: "ann", state, commitOid: "c1",
        originRemoteId: login, originAuthor: login,
      });
    }
    expect([...latestReviewByAuthor(db, "p1").keys()].sort()).toEqual(["x", "y"]);
  });
});

describe("byAnchor", () => {
  test("groups comments on the same file, side and line", () => {
    const a = comment("a.ts", 1, "l");
    const b = comment("a.ts", 1, "l", "new", "ann");
    comment("a.ts", 2, "l");
    comment("b.ts", 1, "l");
    comment("a.ts", 1, "l", "old");
    const groups = byAnchor(listReviewComments(db, "p1"));
    expect(groups.size).toBe(4);
    const same = groups.get("a.ts\0new\0" + 1)!;
    expect(same.map((c) => c.id)).toEqual([a.id, b.id]);
  });
});
