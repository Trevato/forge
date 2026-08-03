import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "X",
  GIT_AUTHOR_EMAIL: "x@f.dev",
  GIT_COMMITTER_NAME: "X",
  GIT_COMMITTER_EMAIL: "x@f.dev",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

describe("cross-repo pull requests (fork → upstream)", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let aliceToken = "";
  let bobToken = "";
  let aliceCookie = "";
  let bobCookie = "";

  async function gitOk(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    return out.trim();
  }
  const form = (f: Record<string, string>) => new URLSearchParams(f);

  async function mkUser(
    username: string,
  ): Promise<{ token: string; cookie: string }> {
    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username,
        email: `${username}@f.dev`,
        password: "cross-repo-pass",
      }),
      redirect: "manual",
    });
    const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
    const token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        password: "cross-repo-pass",
        name: "c",
        scope: "admin",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    return { token, cookie };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-xr-"));
    work = await mkdtemp(join(tmpdir(), "forge-xr-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    ({ token: aliceToken, cookie: aliceCookie } = await mkUser("alice"));
    ({ token: bobToken, cookie: bobCookie } = await mkUser("bob"));

    // Alice's upstream repo with a seed commit.
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${aliceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    const remote = `${base.replace("http://", `http://alice:${aliceToken}@`)}/alice/app.git`;
    await gitOk(["clone", remote, "app"], work);
    const dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "one\ntwo\nthree\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "seed"], dir);
    await gitOk(["push", "origin", "main"], dir);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("bob forks, pushes a change, and opens a PR against alice's repo", async () => {
    // Fork.
    await fetch(`${base}/api/v1/repos/alice/app/forks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bobToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    // Bob pushes a change to his fork.
    const forkRemote = `${base.replace("http://", `http://bob:${bobToken}@`)}/bob/app.git`;
    await gitOk(["clone", forkRemote, "bob-app"], work);
    const dir = join(work, "bob-app");
    await Bun.write(join(dir, "code.txt"), "one\nTWO\nthree\n");
    await gitOk(["commit", "-am", "shout two"], dir);
    await gitOk(["push", "origin", "main"], dir);

    // Bob opens the PR from his fork, targeting the parent (baseRepo=parent).
    const opened = await fetch(`${base}/bob/app/pulls/new`, {
      method: "POST",
      headers: { cookie: bobCookie },
      body: form({
        baseRepo: "parent",
        base: "main",
        head: "main",
        title: "Shout two",
        body: "louder",
      }),
      redirect: "manual",
    });
    expect(opened.status).toBe(303);
    // The PR is created on ALICE's repo, not bob's.
    expect(opened.headers.get("location")).toBe("/alice/app/pulls/1");
  });

  test("the PR on the upstream shows the fork's diff and is mergeable", async () => {
    const pr = await (
      await fetch(`${base}/alice/app/pulls/1`, {
        headers: { cookie: aliceCookie },
      })
    ).text();
    expect(pr).toContain("Shout two");
    expect(pr).toContain("TWO"); // bob's change is visible in alice's repo
    expect(pr).toContain("Ready to merge");
  });

  test("alice merges it; her main gains bob's commit", async () => {
    const merged = await fetch(`${base}/alice/app/pulls/1/merge`, {
      method: "POST",
      headers: { cookie: aliceCookie },
      body: form({ strategy: "merge" }),
      redirect: "manual",
    });
    expect(merged.status).toBe(303);

    const blob = await (
      await fetch(`${base}/alice/app/blob/main/code.txt`)
    ).text();
    expect(blob).toContain("TWO");

    // The head and merged refs live in the base (alice's) repo.
    const refs = await gitOk(
      [
        "-C",
        join(dataDir, "repos/alice/app.git"),
        "for-each-ref",
        "--format=%(refname)",
        "refs/pull/",
      ],
      work,
    );
    expect(refs).toContain("refs/pull/1/head");
    expect(refs).toContain("refs/pull/1/merged");
  });
});
