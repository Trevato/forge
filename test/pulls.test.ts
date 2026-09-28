import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const gitEnv = gitClientEnv();

describe("pull requests end to end", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";
  let token = "";
  let repoDirPath: string;

  async function git(
    args: string[],
    cwd: string,
  ): Promise<{ code: number; err: string }> {
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
    return { code, err };
  }
  async function gitOk(args: string[], cwd: string): Promise<void> {
    const r = await git(args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  }

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);
  const post = (path: string, fields: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie },
      body: form(fields),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pr-"));
    work = await mkdtemp(join(tmpdir(), "forge-pr-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;

    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username: "dev",
        email: "dev@f.dev",
        password: "pull-request-pass",
      }),
      redirect: "manual",
    });
    cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "dev",
        password: "pull-request-pass",
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
    repoDirPath = join(dataDir, "repos/dev/app.git");

    const remote = `${base.replace("http://", `http://dev:${token}@`)}/dev/app.git`;
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

  test("open a PR from a clean branch and see the diff", async () => {
    const dir = join(work, "app");
    await gitOk(["checkout", "-b", "feature"], dir);
    await Bun.write(join(dir, "code.txt"), "alpha\nBETA\ngamma\n");
    await gitOk(["commit", "-am", "loud beta"], dir);
    await gitOk(["push", "origin", "feature"], dir);

    const created = await post("/dev/app/pulls/new", {
      base: "main",
      head: "feature",
      title: "Make beta loud",
      body: "shout",
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/dev/app/pulls/1");

    const pr = await (await fetch(`${base}/dev/app/pulls/1`)).text();
    expect(pr).toContain("Make beta loud");
    expect(pr).toContain("feature → main");
    // The diff viewer rendered the change with intra-line word marks.
    expect(pr).toContain('data-k="del"');
    expect(pr).toContain('data-k="add"');
    expect(pr).toContain("BETA");
    expect(pr).toMatch(/class="[^"]*\bwd\b/); // word-diff highlight present (possibly with a token class)
    expect(pr).toContain("Ready to merge");
  });

  test("merge the PR, base advances, PR shows merged", async () => {
    const merged = await post("/dev/app/pulls/1/merge", { strategy: "merge" });
    expect(merged.status).toBe(303);

    const pr = await (await fetch(`${base}/dev/app/pulls/1`)).text();
    expect(pr).toContain("Merged");

    // main now carries the change.
    const blob = await (
      await fetch(`${base}/dev/app/blob/main/code.txt`)
    ).text();
    expect(blob).toContain("BETA");

    // The durable merged ref exists.
    const refs = await Bun.spawn(
      ["git", "for-each-ref", "--format=%(refname)", "refs/pull/"],
      {
        cwd: repoDirPath,
        env: gitEnv,
        stdout: "pipe",
      },
    );
    const refText = await new Response(refs.stdout).text();
    expect(refText).toContain("refs/pull/1/head");
    expect(refText).toContain("refs/pull/1/merged");
  });

  test("squash-merge keeps a single parent", async () => {
    const dir = join(work, "app");
    await gitOk(["checkout", "main"], dir);
    await gitOk(["pull", "origin", "main"], dir);
    await gitOk(["checkout", "-b", "tidy"], dir);
    await Bun.write(join(dir, "extra.txt"), "one\ntwo\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "a"], dir);
    await Bun.write(join(dir, "extra.txt"), "one\ntwo\nthree\n");
    await gitOk(["commit", "-am", "b"], dir);
    await gitOk(["push", "origin", "tidy"], dir);

    const created = await post("/dev/app/pulls/new", {
      base: "main",
      head: "tidy",
      title: "Tidy up",
      body: "",
    });
    const loc = created.headers.get("location")!;
    await fetch(`${base}${loc}/merge`, {
      method: "POST",
      headers: { cookie },
      body: form({ strategy: "squash" }),
      redirect: "manual",
    });

    // The squash commit on main has exactly one parent.
    const tip = await Bun.spawn(["git", "rev-parse", "main"], {
      cwd: repoDirPath,
      env: gitEnv,
      stdout: "pipe",
    });
    const oid = (await new Response(tip.stdout).text()).trim();
    const parents = await Bun.spawn(
      ["git", "rev-list", "--parents", "-n", "1", oid],
      { cwd: repoDirPath, env: gitEnv, stdout: "pipe" },
    );
    const parentText = (await new Response(parents.stdout).text()).trim();
    expect(parentText.split(" ").length).toBe(2); // commit + one parent
  });

  test("a conflicting PR is blocked from merging", async () => {
    const dir = join(work, "app");
    await gitOk(["checkout", "main"], dir);
    await gitOk(["pull", "origin", "main"], dir);
    // Branch that edits gamma one way…
    await gitOk(["checkout", "-b", "conflict"], dir);
    await Bun.write(join(dir, "code.txt"), "alpha\nBETA\nGAMMA-branch\n");
    await gitOk(["commit", "-am", "branch gamma"], dir);
    await gitOk(["push", "origin", "conflict"], dir);
    // …and main edits the same line the other way.
    await gitOk(["checkout", "main"], dir);
    await Bun.write(join(dir, "code.txt"), "alpha\nBETA\nGAMMA-main\n");
    await gitOk(["commit", "-am", "main gamma"], dir);
    await gitOk(["push", "origin", "main"], dir);

    const created = await post("/dev/app/pulls/new", {
      base: "main",
      head: "conflict",
      title: "Conflict",
      body: "",
    });
    const loc = created.headers.get("location")!;
    const pr = await (await fetch(`${base}${loc}`)).text();
    expect(pr).toContain("Can't merge");
    expect(pr).toContain("Conflicts");

    // And the merge endpoint refuses.
    const attempt = await fetch(`${base}${loc}/merge`, {
      method: "POST",
      headers: { cookie },
      body: form({ strategy: "merge" }),
      redirect: "manual",
    });
    expect(attempt.status).toBe(303);
    const after = await (await fetch(`${base}${loc}`)).text();
    expect(after).not.toContain("Merged");
  });

  test("the commit page renders a commit's diff", async () => {
    const page = await (await fetch(`${base}/dev/app/commit/main`)).text();
    expect(page).toContain("diff-summary");
    // The most recent main commit touched code.txt or extra.txt.
    expect(/code\.txt|extra\.txt/.test(page)).toBe(true);
    const bad = await fetch(`${base}/dev/app/commit/deadbeef`);
    expect(bad.status).toBe(404);
  });

  test("cross-origin merge is refused", async () => {
    const res = await fetch(`${base}/dev/app/pulls/1/merge`, {
      method: "POST",
      headers: { cookie, origin: "http://evil.example" },
      body: form({ strategy: "merge" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });
});
