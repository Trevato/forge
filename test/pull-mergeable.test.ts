import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { createRun, setRunBase } from "../src/core/runs.ts";

const gitEnv = gitClientEnv();

describe("a pull says whether it merges", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";
  let dir: string;

  async function gitOk(args: string[]): Promise<void> {
    const p = Bun.spawn(["git", ...args], {
      cwd: dir,
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
  const auth = { authorization: "" };
  const api = async (path: string, init: RequestInit = {}) =>
    (await fetch(`${base}/api/v1/repos/dev/app${path}`, {
      ...init,
      headers: { ...auth, "content-type": "application/json" },
    })).json() as Promise<any>;
  const mcp = async (name: string, args: unknown, as?: string) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...auth,
        ...(as ? { authorization: `Bearer ${as}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text = body.result.content[0].text as string;
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  };
  const write = async (text: string, message: string) => {
    await Bun.write(join(dir, "code.txt"), text);
    await gitOk(["commit", "-am", message]);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pm-"));
    work = await mkdtemp(join(tmpdir(), "forge-pm-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "dev",
        email: "dev@f.dev",
        password: "pull-mergeable-pass",
      }),
      redirect: "manual",
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "dev",
        password: "pull-mergeable-pass",
        name: "cli",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    auth.authorization = `Bearer ${token}`;
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    const remote = `${base.replace("http://", `http://dev:${token}@`)}/dev/app.git`;
    dir = work;
    await gitOk(["clone", remote, "app"]);
    dir = join(work, "app");
    await Bun.write(join(dir, "code.txt"), "alpha\nbeta\ngamma\n");
    await gitOk(["add", "."]);
    await gitOk(["commit", "-m", "base"]);
    await gitOk(["push", "origin", "main"]);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("a conflicting pull reads false with the path; once the base resolves it, true", async () => {
    await gitOk(["checkout", "-b", "loud"]);
    await write("alpha\nBETA\ngamma\n", "loud beta");
    await gitOk(["push", "origin", "loud"]);
    const made = await api("/pulls", {
      method: "POST",
      body: JSON.stringify({ base: "main", head: "loud", title: "Loud" }),
    });
    expect(made.number).toBe(1);

    // The base takes a different edit of the same line.
    await gitOk(["checkout", "main"]);
    await write("alpha\nbeta!\ngamma\n", "quiet beta");
    await gitOk(["push", "origin", "main"]);

    const one = await api("/pulls/1");
    expect(one.mergeable).toBe(false);
    expect(one.checkStale).toBe(false);
    expect(one.conflicts).toEqual(["code.txt"]);
    const listed = await api("/pulls");
    expect(listed.items[0].mergeable).toBe(false);
    expect(listed.items[0].conflicts).toEqual(["code.txt"]);
    const seen = await mcp("pull", { repo: "dev/app", number: 1 });
    expect(seen.mergeable).toBe(false);
    expect(seen.conflicts).toEqual(["code.txt"]);

    // The base moves to hold the same line the pull wants.
    await write("alpha\nBETA\ngamma\n", "the same edit");
    await gitOk(["push", "origin", "main"]);

    const after = await api("/pulls/1");
    expect(after.mergeable).toBe(true);
    expect(after.conflicts).toEqual([]);
    expect((await api("/pulls")).items[0].mergeable).toBe(true);
    const mcpAfter = await mcp("pull", { repo: "dev/app", number: 1 });
    expect(mcpAfter.mergeable).toBe(true);
    expect(mcpAfter.conflicts).toEqual([]);

    // A check recorded against some other base tip is from an older main.
    const row = app.db
      .query<{ issue_id: string; repo_id: string; head_oid: string }, []>(
        "SELECT pull.issue_id, issue.repo_id, pull.head_oid FROM pull JOIN issue ON issue.id = pull.issue_id LIMIT 1",
      )
      .get()!;
    const run = createRun(app.db, {
      repoId: row.repo_id,
      kind: "check",
      issueId: row.issue_id,
      env: "pull-1",
      commitOid: row.head_oid,
    });
    setRunBase(app.db, run.id, "abc1234abc1234abc1234abc1234abc1234abc12");
    expect((await api("/pulls/1")).checkStale).toBe(true);
    expect((await mcp("pull", { repo: "dev/app", number: 1 })).checkStale).toBe(true);
    // A merged pull is not called stale once main moves on.
    app.db.query("UPDATE pull SET merged_at = '2026-10-01T00:00:00.000Z' WHERE issue_id = ?1").run(row.issue_id);
    expect((await api("/pulls/1")).checkStale).toBe(false);
    expect((await mcp("pull", { repo: "dev/app", number: 1 })).checkStale).toBe(false);
    app.db.query("UPDATE pull SET merged_at = NULL WHERE issue_id = ?1").run(row.issue_id);
  });

  test("a sealed pull answers no_such_pull to a reader who cannot see it", async () => {
    const sealed = await mcp("seal", { repo: "dev/app", number: 1, sealed: true });
    expect(sealed.sealed).toBe(true);
    await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "eve",
        email: "eve@f.dev",
        password: "eve-reader-pass-1",
      }),
      redirect: "manual",
    });
    const eve = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adminConfirm: true,
        username: "eve",
        password: "eve-reader-pass-1",
        name: "cli",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    const hidden = await mcp("pull", { repo: "dev/app", number: 1 }, eve);
    expect(hidden.error).toContain("no_such_pull");
    expect((await mcp("pull", { repo: "dev/app", number: 1 })).number).toBe(1);
    await mcp("seal", { repo: "dev/app", number: 1, sealed: false });
  });

  test("a closed pull leaves out mergeable and conflicts everywhere", async () => {
    const closed = await api("/pulls/1", {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    expect(closed.state).toBe("closed");
    const one = await api("/pulls/1");
    expect(one.state).toBe("closed");
    expect("mergeable" in one).toBe(false);
    expect("conflicts" in one).toBe(false);
    const listed = await api("/pulls?state=all");
    expect(listed.items[0].state).toBe("closed");
    expect("mergeable" in listed.items[0]).toBe(false);
    expect("conflicts" in listed.items[0]).toBe(false);
    const seen = await mcp("pull", { repo: "dev/app", number: 1 });
    expect(seen.state).toBe("closed");
    expect("mergeable" in seen).toBe(false);
    expect("conflicts" in seen).toBe(false);
  });
});
