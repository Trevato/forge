import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/core/repos.ts";
import { importIssue, type ImportContext } from "../src/origins/import.ts";
import type { RemoteIssue } from "../src/origins/types.ts";
import { seedAdmin } from "./helpers/admin.ts";

/** `importIssue` on its own: one row per origin id, numbers kept, sequence dragged up. */

const remote = (over: Partial<RemoteIssue> = {}): RemoteIssue => ({
  remoteId: "r-40",
  number: 40,
  title: "Remote title",
  body: "body",
  author: "octo",
  state: "open",
  labels: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  closedAt: null,
  htmlUrl: "https://origin.test/o/r/issues/40",
  comments: 0,
  ...over,
});

describe("importIssue", () => {
  let dir: string;
  let app: App;
  let ctx: ImportContext;
  let authorId: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-import-issue-"));
    app = createApp({ dataDir: dir, port: 0 });
    const user = await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.test",
      password: "alice-login-secret",
    });
    if (!user.ok) throw new Error(`no user: ${user.error}`);
    authorId = user.value.id;
    const repo = await createRepo(app.db, join(dir, "repos"), {
      ownerId: authorId,
      name: "mirror",
    });
    if (!repo.ok) throw new Error(`no repo: ${repo.error}`);
    ctx = { db: app.db, repoId: repo.value.id, actorId: authorId };
  });

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const rows = (remoteId: string) =>
    app.db
      .query<
        { id: string; title: string; number: number; kind: string; author_id: string },
        [string, string]
      >("SELECT id, title, number, kind, author_id FROM issue WHERE repo_id = ?1 AND origin_remote_id = ?2")
      .all(ctx.repoId, remoteId);

  test("the same remote issue twice is one row: created, then not; a new title updates it", () => {
    const first = importIssue(ctx, remote());
    expect(first.created).toBe(true);
    expect(first.number).toBe(40);
    expect(first.kind).toBe("issue");

    const again = importIssue(ctx, remote());
    expect(again.created).toBe(false);
    expect(again.issueId).toBe(first.issueId);
    expect(rows("r-40")).toHaveLength(1);

    const renamed = importIssue(
      ctx,
      remote({ title: "Renamed upstream", updatedAt: "2026-01-03T00:00:00.000Z" }),
    );
    expect(renamed.created).toBe(false);
    expect(renamed.changed).toBe(true);
    const [row] = rows("r-40");
    expect(row?.title).toBe("Renamed upstream");
    expect(row?.author_id).toBe(authorId);
  });

  test("after importing #40 the next native issue is numbered above 40", () => {
    const native = createIssue(app.db, {
      repoId: ctx.repoId,
      authorId,
      title: "native",
    });
    if (!native.ok) throw new Error(native.error);
    expect(native.value.number).toBeGreaterThan(40);
  });

  test("a blank remote title reads #<number>", () => {
    importIssue(ctx, remote({ remoteId: "r-41", number: 41, title: "  \n " }));
    expect(rows("r-41")[0]?.title).toBe("#41");
  });

  test("a remote with pull set imports as a pull", () => {
    const got = importIssue(
      ctx,
      remote({
        remoteId: "r-60",
        number: 60,
        pull: {
          baseBranch: "main",
          headBranch: "feature",
          headRepo: "o/r",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
          mergedAt: null,
          draft: false,
        },
      }),
    );
    expect(got.kind).toBe("pull");
    expect(rows("r-60")[0]?.kind).toBe("pull");
    const pull = app.db
      .query<{ head_branch: string }, [string]>(
        "SELECT head_branch FROM pull WHERE issue_id = ?1",
      )
      .get(got.issueId);
    expect(pull?.head_branch).toBe("feature");
  });
});
