import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { hashLine } from "../src/core/reviews.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { adminCookie } from "./helpers/admin.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Rev",
  GIT_AUTHOR_EMAIL: "rev@f.dev",
  GIT_COMMITTER_NAME: "Rev",
  GIT_COMMITTER_EMAIL: "rev@f.dev",
});

describe("review comments on diff lines", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";
  let token = "";

  async function gitOk(args: string[], cwd: string): Promise<void> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  }
  const form = (f: Record<string, string>) => new URLSearchParams(f);
  const post = (
    path: string,
    f: Record<string, string>,
    headers: Record<string, string> = { cookie },
  ) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: form(f),
      redirect: "manual",
    });

  // Each test that reads or rewrites a branch opens its own pull on its own
  // branch, so no test depends on what another left behind.
  async function openPr(branch: string): Promise<string> {
    const dir = join(work, "app");
    await gitOk(["checkout", "-B", branch, "main"], dir);
    await Bun.write(join(dir, "code.txt"), "alpha\nBETA\ngamma\ndelta\n");
    await gitOk(["commit", "-am", "change"], dir);
    await gitOk(["push", "origin", branch], dir);
    const res = await post("/rev/app/pulls/new", {
      base: "main",
      head: branch,
      title: "PR",
      body: "",
    });
    return res.headers.get("location")!.replace(/\/files$/, "");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-rev-"));
    work = await mkdtemp(join(tmpdir(), "forge-rev-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    cookie = await adminCookie(app, {
      username: "rev",
      email: "rev@f.dev",
      password: "review-me-please",
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "rev",
        password: "review-me-please",
        name: "cli",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });

    const remote = `${base.replace("http://", `http://rev:${token}@`)}/rev/app.git`;
    await gitOk(["clone", remote, "app"], work);
    const dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "alpha\nbeta\ngamma\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "base"], dir);
    await gitOk(["push", "origin", "main"], dir);
    await gitOk(["checkout", "-b", "feature"], dir);
    await Bun.write(join(dir, "code.txt"), "alpha\nBETA\ngamma\ndelta\n");
    await gitOk(["commit", "-am", "change"], dir);
    await gitOk(["push", "origin", "feature"], dir);
    await post("/rev/app/pulls/new", {
      base: "main",
      head: "feature",
      title: "PR",
      body: "",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("the line-number gutter offers a comment affordance on a PR diff", async () => {
    const pr = await (
      await fetch(`${base}/rev/app/pulls/1/files`, { headers: { cookie } })
    ).text();
    expect(pr).toContain("dn-comment");
    expect(pr).toContain("?rc=");
  });

  test("the ?rc anchor opens an inline comment form at that line", async () => {
    const rc = `rc=${encodeURIComponent("code.txt")}~new~2`;
    // An older link to the change itself is handed on to its Files step.
    const old = await fetch(`${base}/rev/app/pulls/1?${rc}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(old.status).toBe(303);
    expect(old.headers.get("location")).toBe(`/rev/app/pulls/1/files?${rc}`);
    const pr = await (
      await fetch(`${base}/rev/app/pulls/1/files?${rc}`, { headers: { cookie } })
    ).text();
    expect(pr).toContain('action="/rev/app/pulls/1/review"');
    expect(pr).toContain('name="line" value="2"');
    expect(pr).toContain('name="side" value="new"');
  });

  test("a posted review comment appears inline, anchored to its line", async () => {
    const pull = await openPr("topic-a");
    // "BETA" is the new-side content of line 2; anchor to it.
    const res = await post(`${pull}/review`, {
      path: "code.txt",
      side: "new",
      line: "2",
      lineHash: hashLine("BETA"),
      body: "why so loud?",
    });
    expect(res.status).toBe(303);
    const pr = await (
      await fetch(`${base}${pull}/files`, { headers: { cookie } })
    ).text();
    expect(pr).toContain("why so loud?");
    expect(pr).not.toContain("outdated"); // hash matches the current line
  });

  test("a comment whose line content changed is marked outdated, not misplaced", async () => {
    const pull = await openPr("topic-b");
    // Anchor a comment to line 3 ("gamma"), then rewrite that line on the
    // branch. The server hashed the content it saw, so the comment must now
    // read as outdated — never silently re-land on the new text.
    const kept = await post(`${pull}/review`, {
      path: "code.txt",
      side: "new",
      line: "2",
      body: "why so loud?",
    });
    expect(kept.status).toBe(303);
    const posted = await post(`${pull}/review`, {
      path: "code.txt",
      side: "new",
      line: "3",
      body: "stale anchor",
    });
    expect(posted.status).toBe(303);
    const before = await (
      await fetch(`${base}${pull}/files`, { headers: { cookie } })
    ).text();
    expect(before).not.toContain("outdated");
    const dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "alpha\nBETA\nGAMMA\ndelta\n");
    await gitOk(["commit", "-am", "rewrite line 3"], dir);
    await gitOk(["push", "origin", "topic-b"], dir);
    const pr = await (
      await fetch(`${base}${pull}/files`, { headers: { cookie } })
    ).text();
    expect(pr).toContain("stale anchor");
    expect(pr).toContain("outdated"); // content hash no longer matches
    expect(pr).toContain("why so loud?"); // line 2 is untouched: still current
  });

  test("a read-only token cannot post a review comment", async () => {
    const roToken = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "rev",
        password: "review-me-please",
        name: "ro",
        scope: "ro",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    const res = await post(
      "/rev/app/pulls/1/review",
      {
        path: "code.txt",
        side: "new",
        line: "2",
        lineHash: hashLine("BETA"),
        body: "nope",
      },
      {
        authorization: `Bearer ${roToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
    );
    expect(res.status).toBe(403);
  });

  test("cross-origin review post is refused", async () => {
    const res = await post(
      "/rev/app/pulls/1/review",
      {
        path: "code.txt",
        side: "new",
        line: "2",
        lineHash: hashLine("BETA"),
        body: "csrf",
      },
      { cookie, origin: "http://evil.example" },
    );
    expect(res.status).toBe(403);
  });
});
