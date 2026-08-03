import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, createIssue, listComments } from "../src/core/issues.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("live comment threads", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let userId = "";
  let issueNumber = 0;
  let firstCommentId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-live-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const user = await createUser(app.db, {
      username: "liv",
      email: "l@f.dev",
      password: "live-thread-pass",
    });
    if (!user.ok) throw new Error("user");
    userId = user.value.id;
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: userId,
      name: "proj",
      visibility: "public",
    });
    if (!repo.ok) throw new Error("repo");
    const issue = createIssue(app.db, {
      repoId: repo.value.id,
      authorId: userId,
      title: "live",
      body: "start",
    });
    if (!issue.ok) throw new Error("issue");
    issueNumber = issue.value.number;
    const c1 = addComment(app.db, {
      issueId: issue.value.id,
      authorId: userId,
      body: "first comment",
    });
    addComment(app.db, {
      issueId: issue.value.id,
      authorId: userId,
      body: "second comment",
    });
    if (!c1.ok) throw new Error("comment");
    firstCommentId = c1.value.id;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the issue page wires up the live client", async () => {
    const html = await (
      await fetch(`${base}/liv/proj/issues/${issueNumber}`)
    ).text();
    expect(html).toContain('id="live"');
    expect(html).toContain('id="conversation"');
    expect(html).toContain('data-thread="issue"');
    expect(html).toContain("new EventSource");
    // Comments carry stable ids the client tracks.
    expect(html).toContain("data-comment-id=");
  });

  test("the thread fragment returns only comments after the given id", async () => {
    const frag = await (
      await fetch(
        `${base}/liv/proj/issues/${issueNumber}/thread?after=${firstCommentId}`,
      )
    ).text();
    expect(frag).toContain("second comment");
    expect(frag).not.toContain("first comment");
    expect(frag).toContain("data-comment-id=");
    // It's a fragment, not a full page.
    expect(frag).not.toContain("<!doctype html>");
  });

  test("a fragment with after=<latest> is empty", async () => {
    const issueId = app.db
      .query<{ id: string }, [number]>("SELECT id FROM issue WHERE number = ?1")
      .get(issueNumber)!.id;
    const all = listComments(app.db, issueId);
    const lastId = all[all.length - 1]!.id;
    const frag = await (
      await fetch(
        `${base}/liv/proj/issues/${issueNumber}/thread?after=${lastId}`,
      )
    ).text();
    expect(frag.trim()).toBe("");
  });

  test("the fragment respects repo visibility", async () => {
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: userId,
      name: "secret",
      visibility: "private",
    });
    if (!repo.ok) throw new Error("repo");
    const issue = createIssue(app.db, {
      repoId: repo.value.id,
      authorId: userId,
      title: "x",
      body: "",
    });
    if (!issue.ok) throw new Error("issue");
    const anon = await fetch(
      `${base}/liv/secret/issues/${issue.value.number}/thread`,
    );
    expect(anon.status).toBe(404);
  });
});
