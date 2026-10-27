import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

const gitEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "X",
  GIT_AUTHOR_EMAIL: "x@f.dev",
  GIT_COMMITTER_NAME: "X",
  GIT_COMMITTER_EMAIL: "x@f.dev",
});

describe("opening a pull that cannot be one", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";

  async function gitOk(args: string[], cwd: string): Promise<void> {
    const p = Bun.spawn(["git", ...args], {
      cwd,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([
      new Response(p.stderr).text(),
      p.exited,
      new Response(p.stdout).text(),
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  }

  const call = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const open = (body: Record<string, unknown>) =>
    call("/api/v1/repos/alice/app/pulls", { title: "A change", ...body });

  const pullRows = (): number =>
    app.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM pull")
      .get()!.n;
  const issueRows = (): number =>
    app.db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM issue")
      .get()!.n;

  async function refused(body: Record<string, unknown>, code: string) {
    const pulls = pullRows();
    const issues = issueRows();
    const res = await open(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(JSON.stringify(await res.json())).toContain(code);
    expect(pullRows()).toBe(pulls);
    expect(issueRows()).toBe(issues);
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-refuse-"));
    work = await mkdtemp(join(tmpdir(), "forge-refuse-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        email: "alice@f.dev",
        password: "refusal-pass-1",
      }),
      redirect: "manual",
    });
    token = tokenFor(app, "alice", "admin", "r");
    proveAll(app);
    promote(app.db);
    await call("/api/v1/repos", { name: "app", visibility: "public" });
    const remote = `${base.replace("http://", `http://alice:${token}@`)}/alice/app.git`;
    await gitOk(["clone", remote, "app"], work);
    const dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "one\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "seed"], dir);
    await gitOk(["push", "origin", "main"], dir);
    // A branch level with main: exists, but has nothing ahead of it.
    await gitOk(["push", "origin", "main:level"], dir);
    // A branch with a commit ahead of main.
    await gitOk(["checkout", "-b", "ahead"], dir);
    await Bun.write(join(dir, "code.txt"), "one\ntwo\n");
    await gitOk(["commit", "-am", "two"], dir);
    await gitOk(["push", "origin", "ahead"], dir);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("a head equal to base is same_branch", async () => {
    await refused({ base: "main", head: "main" }, "same_branch");
  });

  test("a head branch that does not exist is unknown_head", async () => {
    await refused({ base: "main", head: "ghost" }, "unknown_head");
  });

  test("a head with no commit ahead of base is nothing_to_merge", async () => {
    await refused({ base: "main", head: "level" }, "nothing_to_merge");
  });

  test("a cross-repository head with base's branch name is allowed, and no number was spent by the refusals", async () => {
    const forked = await call("/api/v1/repos/alice/app/forks", {
      name: "app-fork",
    });
    expect(forked.status).toBeLessThan(300);
    const forkOwnerRepo = ((await forked.json()) as { fullName?: string })
      .fullName;
    const dir = join(work, "app");
    const remote = `${base.replace("http://", `http://alice:${token}@`)}/alice/${
      forkOwnerRepo?.split("/")[1] ?? "app-fork"
    }.git`;
    await gitOk(["checkout", "-b", "main-fork-work", "main"], dir);
    await Bun.write(join(dir, "fork.txt"), "fork\n");
    await gitOk(["add", "."], dir);
    await gitOk(["commit", "-m", "fork work"], dir);
    await gitOk(["push", remote, "main-fork-work:main", "--force"], dir);

    const res = await open({
      base: "main",
      head: "main",
      headRepo: forkOwnerRepo ?? "alice/app-fork",
    });
    expect(res.status).toBe(201);
    const pull = (await res.json()) as { number: number; crossRepo: boolean };
    expect(pull.crossRepo).toBe(true);
    // Three refusals came first; none of them used a number.
    expect(pull.number).toBe(1);
  });
});
