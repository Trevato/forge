/**
 * Adversarial regression tests found during stress-testing of merge & PR/issue
 * authorization. See docs/ARCHITECTURE.md for the token-scope model
 * (ro < rw < admin). These tests pin down a confirmed bug: the web (HTML
 * form) mutation routes for issues, pulls, merge, and settings never check
 * the presented token's scope — only that a token resolves to the repo
 * owner. A read-only ("ro") token should not be able to merge PRs, open
 * PRs, open issues, or change repo settings, but currently can.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Dev",
  GIT_AUTHOR_EMAIL: "dev@f.dev",
  GIT_COMMITTER_NAME: "Dev",
  GIT_COMMITTER_EMAIL: "dev@f.dev",
});

describe("security: read-only token scope bypass on web mutation routes", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let rwToken = "";
  let roToken = "";

  async function gitOk(args: string[], cwd: string): Promise<void> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [errText, code] = await Promise.all([
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${errText}`);
  }

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sec-"));
    work = await mkdtemp(join(tmpdir(), "forge-sec-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "alice",
        password: "password12345",
        displayName: "Alice",
      }),
    });

    rwToken = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ adminConfirm: true,
        username: "alice",
        password: "password12345",
        name: "rw",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);

    // Mint the read-only token using a session obtained via the rw token's
    // owning user (both tokens belong to the same account).
    const sessionRes = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "password12345" }),
    });
    const cookie = (sessionRes.headers.get("set-cookie") ?? "").split(";")[0]!;

    roToken = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true, name: "ro", scope: "ro" }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);

    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rwToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "demo", visibility: "public" }),
    });

    const remote = `${base.replace("http://", `http://alice:${rwToken}@`)}/alice/demo.git`;
    await gitOk(["clone", remote, "demo"], work);
    const dir = join(work, "demo");
    await Bun.write(join(dir, "file.txt"), "line1\nline2\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "init"], dir);
    await gitOk(["push", "origin", "main"], dir);
    await gitOk(["checkout", "-b", "feature"], dir);
    await Bun.write(join(dir, "file.txt"), "line1-changed\nline2\n");
    await gitOk(["commit", "-am", "feature change"], dir);
    await gitOk(["push", "origin", "feature"], dir);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  // Sanity: the git-over-HTTP write path DOES enforce token scope.
  test("a read-only token cannot push over git-receive-pack", async () => {
    const dir = join(work, "demo");
    const remote = `${base.replace("http://", `http://alice:${roToken}@`)}/alice/demo.git`;
    const p = Bun.spawn(
      ["git", "push", remote, "HEAD:refs/heads/ro-push-attempt"],
      { cwd: dir, env: gitEnv, stdout: "ignore", stderr: "pipe" },
    );
    const code = await p.exited;
    expect(code).not.toBe(0);
  });

  // A read-only token is rejected (403) on every web mutation route, matching
  // the git-push and JSON-API paths. readForm enforces the scope floor.

  test("a read-only token cannot open a pull request via the web route", async () => {
    const res = await fetch(`${base}/alice/demo/pulls/new`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${roToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({
        base: "main",
        head: "feature",
        title: "RO-token PR",
        body: "no",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  test("a read-only token cannot merge a pull request via the web route", async () => {
    // Open a PR with the rw token first, then try to merge it with the ro token.
    await fetch(`${base}/alice/demo/pulls/new`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rwToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ base: "main", head: "feature", title: "PR", body: "" }),
      redirect: "manual",
    });
    const res = await fetch(`${base}/alice/demo/pulls/1/merge`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${roToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ strategy: "merge" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    const page = await (await fetch(`${base}/alice/demo/pulls/1`)).text();
    expect(page).not.toContain("Merged.");
  });

  test("a read-only token cannot open an issue via the web route", async () => {
    const res = await fetch(`${base}/alice/demo/issues/new`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${roToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ title: "RO-token issue", body: "no" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });

  test("a read-only token cannot change repo settings via the web route", async () => {
    const res = await fetch(`${base}/alice/demo/settings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${roToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form({ visibility: "private", description: "pwned via ro token" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);

    const repo = await fetch(`${base}/api/v1/repos/alice/demo`, {
      headers: { authorization: `Bearer ${rwToken}` },
    }).then((r) => r.json());
    expect((repo as { visibility: string }).visibility).toBe("public");
    expect((repo as { description: string }).description).not.toBe(
      "pwned via ro token",
    );
  });
});

describe("merge correctness (clean results, recorded for regression)", () => {
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
    const [errText, code] = await Promise.all([
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${errText}`);
  }
  async function gitCapture(args: string[], cwd: string): Promise<string> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  }

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-merge-"));
    work = await mkdtemp(join(tmpdir(), "forge-merge-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username: "bob",
        email: "bob@f.dev",
        password: "merge-test-pass",
      }),
      redirect: "manual",
    });
    cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "bob",
        password: "merge-test-pass",
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

    const remote = `${base.replace("http://", `http://bob:${token}@`)}/bob/app.git`;
    await gitOk(["clone", remote, "app"], work);
    const dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "alpha\nbeta\ngamma\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "base"], dir);
    await gitOk(["push", "origin", "main"], dir);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  // Each test builds its own branches and pull requests from the current
  // main, and reads the pull number the forge hands back, so no test depends
  // on what another left behind or on the order they run in.
  async function branchFromMain(
    name: string,
    file: string,
    content: string,
  ): Promise<void> {
    const dir = join(work, "app");
    await gitOk(["fetch", "origin"], dir);
    await gitOk(["checkout", "-B", "main", "origin/main"], dir);
    await gitOk(["checkout", "-b", name], dir);
    await Bun.write(join(dir, file), content);
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", `change on ${name}`], dir);
    await gitOk(["push", "origin", name], dir);
  }

  async function openPull(head: string): Promise<number> {
    const res = await fetch(`${base}/bob/app/pulls/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ base: "main", head, title: `PR ${head}`, body: "" }),
      redirect: "manual",
    });
    const m = /\/pulls\/(\d+)$/.exec(res.headers.get("location") ?? "");
    if (!m) throw new Error(`pull for ${head} not opened: ${res.status}`);
    return Number(m[1]);
  }

  async function mergePull(n: number, strategy: string): Promise<void> {
    await fetch(`${base}/bob/app/pulls/${n}/merge`, {
      method: "POST",
      headers: { cookie },
      body: form({ strategy }),
    });
  }

  async function parentCount(sha: string, gitDir: string): Promise<number> {
    return (await gitCapture(["cat-file", "-p", sha], gitDir))
      .split("\n")
      .filter((l) => l.startsWith("parent ")).length;
  }

  test("squash merge produces exactly one parent; regular merge produces exactly two", async () => {
    const repoGitDir = join(dataDir, "repos/bob/app.git");

    await branchFromMain("squash-feature", "code.txt", "alpha\nBETA\ngamma\n");
    const squashPr = await openPull("squash-feature");
    await mergePull(squashPr, "squash");
    const squashSha = await gitCapture(
      ["rev-parse", `refs/pull/${squashPr}/merged`],
      repoGitDir,
    );
    expect(await parentCount(squashSha, repoGitDir)).toBe(1);

    await branchFromMain("merge-feature", "other.txt", "new file\n");
    const mergePr = await openPull("merge-feature");
    await mergePull(mergePr, "merge");
    const mergeSha = await gitCapture(
      ["rev-parse", `refs/pull/${mergePr}/merged`],
      repoGitDir,
    );
    expect(await parentCount(mergeSha, repoGitDir)).toBe(2);
  });

  test("refs/pull/N/merged survives `git gc --prune=now`", async () => {
    const repoGitDir = join(dataDir, "repos/bob/app.git");
    await branchFromMain("gc-feature", "gc.txt", "gc me\n");
    const pr = await openPull("gc-feature");
    await mergePull(pr, "squash");
    const ref = `refs/pull/${pr}/merged`;
    const before = await gitCapture(["rev-parse", ref], repoGitDir);
    await gitOk(["gc", "--prune=now"], repoGitDir);
    const after = await gitCapture(["rev-parse", ref], repoGitDir);
    expect(after).toBe(before);
    // The object itself must still resolve, not just the ref.
    const catOut = await gitCapture(["cat-file", "-t", after], repoGitDir);
    expect(catOut).toBe("commit");
  });

  test("a conflicting merge attempt leaves the base ref completely unchanged", async () => {
    const repoGitDir = join(dataDir, "repos/bob/app.git");

    // Both branches rewrite the same file from the same base, so whichever
    // merges second genuinely conflicts.
    await branchFromMain("conflict-a", "conflict.txt", "A\n");
    await branchFromMain("conflict-b", "conflict.txt", "B\n");
    const a = await openPull("conflict-a");
    const b = await openPull("conflict-b");
    await mergePull(a, "merge");

    const before = await gitCapture(
      ["rev-parse", "refs/heads/main"],
      repoGitDir,
    );
    await mergePull(b, "merge");
    const after = await gitCapture(
      ["rev-parse", "refs/heads/main"],
      repoGitDir,
    );
    expect(after).toBe(before);

    const page = await (await fetch(`${base}/bob/app/pulls/${b}/files`)).text();
    expect(page).toContain("Can't merge.");
  });
});
