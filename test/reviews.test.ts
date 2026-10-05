import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { hashLine } from "../src/core/reviews.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-rev-"));
    work = await mkdtemp(join(tmpdir(), "forge-rev-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username: "rev",
        email: "rev@f.dev",
        password: "review-me-please",
      }),
      redirect: "manual",
    });
    cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
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
      await fetch(`${base}/rev/app/pulls/1`, { headers: { cookie } })
    ).text();
    expect(pr).toContain("dn-comment");
    expect(pr).toContain("?rc=");
  });

  test("the ?rc anchor opens an inline comment form at that line", async () => {
    const pr = await (
      await fetch(
        `${base}/rev/app/pulls/1?rc=${encodeURIComponent("code.txt")}~new~2`,
        { headers: { cookie } },
      )
    ).text();
    expect(pr).toContain('action="/rev/app/pulls/1/review"');
    expect(pr).toContain('name="line" value="2"');
    expect(pr).toContain('name="side" value="new"');
  });

  test("a posted review comment appears inline, anchored to its line", async () => {
    // "BETA" is the new-side content of line 2; anchor to it.
    const res = await post("/rev/app/pulls/1/review", {
      path: "code.txt",
      side: "new",
      line: "2",
      lineHash: hashLine("BETA"),
      body: "why so loud?",
    });
    expect(res.status).toBe(303);
    const pr = await (
      await fetch(`${base}/rev/app/pulls/1`, { headers: { cookie } })
    ).text();
    expect(pr).toContain("why so loud?");
    expect(pr).not.toContain("outdated"); // hash matches the current line
  });

  test("a comment whose line content changed is marked outdated, not misplaced", async () => {
    // Anchor a comment to line 3 ("gamma"), then rewrite that line on the
    // branch. The server hashed the content it saw, so the comment must now
    // read as outdated — never silently re-land on the new text.
    const posted = await post("/rev/app/pulls/1/review", {
      path: "code.txt",
      side: "new",
      line: "3",
      body: "stale anchor",
    });
    expect(posted.status).toBe(303);
    const dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "alpha\nBETA\nGAMMA\ndelta\n");
    await gitOk(["commit", "-am", "rewrite line 3"], dir);
    await gitOk(["push", "origin", "feature"], dir);
    const pr = await (
      await fetch(`${base}/rev/app/pulls/1`, { headers: { cookie } })
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
