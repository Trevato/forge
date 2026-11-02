import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  commentByRemoteId,
  importComments,
  importIssue,
  importReviews,
  type ImportContext,
} from "../src/origins/import.ts";
import type {
  RemoteComment,
  RemoteIssue,
  RemoteReview,
} from "../src/origins/types.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * Re-syncing an origin is idempotent: the overlap window replays items the
 * forge already holds, and comments and reviews are upserted on the origin's
 * own ids, so a replay adds nothing and an edit moves the row in place.
 */

const AT = "2026-01-01T00:00:00Z";

const remoteIssue = (number: number, withPull: boolean): RemoteIssue => ({
  remoteId: `ri-${number}`,
  number,
  title: `Thing ${number}`,
  body: "",
  author: "octo",
  state: "open",
  labels: [],
  createdAt: AT,
  updatedAt: AT,
  closedAt: null,
  htmlUrl: `https://origin.test/o/r/issues/${number}`,
  comments: 0,
  ...(withPull
    ? {
        pull: {
          baseBranch: "main",
          headBranch: "topic",
          headRepo: "o/r",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
          mergedAt: null,
          draft: false,
        },
      }
    : {}),
});

const remoteComment = (remoteId: string, body: string): RemoteComment => ({
  remoteId,
  author: "octo",
  body,
  createdAt: AT,
  updatedAt: AT,
  htmlUrl: `https://origin.test/c/${remoteId}`,
});

const remoteReview = (remoteId: string, body: string): RemoteReview => ({
  remoteId,
  author: "octo",
  body,
  path: "src/a.ts",
  line: 3,
  side: "new",
  createdAt: AT,
  htmlUrl: `https://origin.test/r/${remoteId}`,
});

describe("origin import: comments and reviews upsert on the origin's ids", () => {
  let dir: string;
  let app: App;
  let ctx: ImportContext;

  const count = (issueId: string, kind: "comment" | "review"): number =>
    app.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND kind = ?2",
      )
      .get(issueId, kind)!.n;

  const bodyOf = (commentId: string): string | undefined =>
    app.db
      .query<{ body: string }, [string]>(
        "SELECT body FROM comment WHERE id = ?1",
      )
      .get(commentId)?.body;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-import-comments-"));
    app = createApp({ dataDir: dir, port: 0 });
    const made = await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.test",
      password: "alice-login-secret",
    });
    if (!made.ok) throw new Error(`no admin: ${made.error}`);
    app.db
      .query("INSERT INTO repo (id, owner_id, name) VALUES ('repo1', ?1, 'mirror')")
      .run(made.value.id);
    ctx = { db: app.db, repoId: "repo1", actorId: made.value.id };
  });

  afterAll(async () => {
    app.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a second sync of the same two comments adds no row", () => {
    const { issueId } = importIssue(ctx, remoteIssue(1, false));
    const thread = [remoteComment("c1", "first"), remoteComment("c2", "second")];

    expect(importComments(ctx, issueId, thread)).toBe(2);
    expect(count(issueId, "comment")).toBe(2);

    expect(importComments(ctx, issueId, thread)).toBe(0);
    expect(count(issueId, "comment")).toBe(2);
  });

  test("an edited remote comment updates its row in place", () => {
    const { issueId } = importIssue(ctx, remoteIssue(2, false));
    importComments(ctx, issueId, [remoteComment("c1", "before")]);
    const rowId = commentByRemoteId(app.db, issueId, "c1");
    expect(rowId).toBeDefined();

    const edited = { ...remoteComment("c1", "after"), updatedAt: "2026-02-01T00:00:00Z" };
    expect(importComments(ctx, issueId, [edited])).toBe(0);

    expect(commentByRemoteId(app.db, issueId, "c1")).toBe(rowId!);
    expect(bodyOf(rowId!)).toBe("after");
    expect(count(issueId, "comment")).toBe(1);
  });

  test("the same remote id on two issues stays two rows", () => {
    const a = importIssue(ctx, remoteIssue(3, false)).issueId;
    const b = importIssue(ctx, remoteIssue(4, false)).issueId;
    importComments(ctx, a, [remoteComment("shared", "on a")]);
    importComments(ctx, b, [remoteComment("shared", "on b")]);
    expect(bodyOf(commentByRemoteId(app.db, a, "shared")!)).toBe("on a");
    expect(bodyOf(commentByRemoteId(app.db, b, "shared")!)).toBe("on b");
  });

  test("reviews imported twice leave one review per remote id, edits in place", () => {
    const { issueId } = importIssue(ctx, remoteIssue(5, true));
    const head = "b".repeat(40);
    const reviews = [remoteReview("r1", "nit"), remoteReview("r2", "why?")];

    expect(importReviews(ctx, issueId, head, undefined, reviews)).toBe(2);
    expect(importReviews(ctx, issueId, head, undefined, reviews)).toBe(0);
    expect(count(issueId, "review")).toBe(2);

    const rowId = commentByRemoteId(app.db, issueId, "r1")!;
    expect(
      importReviews(ctx, issueId, head, undefined, [remoteReview("r1", "fixed")]),
    ).toBe(0);
    expect(commentByRemoteId(app.db, issueId, "r1")).toBe(rowId);
    expect(bodyOf(rowId)).toBe("fixed");
    expect(count(issueId, "review")).toBe(2);
  });
});
