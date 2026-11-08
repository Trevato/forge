/**
 * The `here` tool answers what an app's `/__forge/` door shows, for a link:
 * production and a preview, and the door's refusal for a foreign host and
 * for a private app the caller may not enter.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createRun, claimRun, finishRun } from "../src/core/runs.ts";
import { createIssue, getIssue } from "../src/core/issues.ts";
import { setSealed } from "../src/core/sealed.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

describe("MCP here", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let aliceRw: string;
  let bobRw: string;
  let pull = 0;
  let id = 1;

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "here", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-app-deploy-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    const alice = getUserByName(app.db, "alice")!;
    const made = await newApp(app, alice, { name: "hello", visibility: "public" } as never);
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "hello")!;
    const committed = await commitToBranch(app, alice, repo, {
      branch: "greeting",
      base: repo.defaultBranch,
      message: "Say hello",
      files: [{ path: "GREETING.md", content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: "Say hello",
      baseBranch: repo.defaultBranch,
      headBranch: "greeting",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value.number;
    const secret = await newApp(app, alice, { name: "vault", visibility: "private" } as never);
    if (!secret.ok) throw new Error(String(secret.error));
    aliceRw = tokenFor(app, "alice", "rw");
    bobRw = tokenFor(app, "bob", "rw");
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const host = (label: string) => `http://${label}.apps.test:${servers.port}/anything`;

  test("production: app, repo, no pull, the links home", async () => {
    const r = await tool(bobRw, { url: host("hello") });
    expect(r.value.app).toBe("hello");
    expect(r.value.repo).toBe("alice/hello");
    expect(r.value.environment).toBe("production");
    expect(r.value.pull).toBeNull();
    expect(r.value.working).toEqual([]);
    expect(r.value.links.home).toBe(servers.url);
    expect(r.value.links.repo).toBe(`${servers.url}/alice/hello`);
    expect(r.value.links.report).toBe(`${servers.url}/alice/hello/report`);
  });

  test("a preview names its pull", async () => {
    const r = await tool(bobRw, { url: host(`hello--${pull}`) });
    expect(r.value.environment).toBe(`pull-${pull}`);
    expect(r.value.pull).toEqual({ number: pull, title: "Say hello" });
  });

  test("a foreign host and a bad link are refused in the forge's words", async () => {
    for (const url of ["https://example.com/", "ftp://hello.apps.test/", host("nothing")]) {
      const r = await tool(aliceRw, { url });
      expect(r.error).toMatch(/not a page of this forge|no such page here/);
    }
  });

  test("a private app the caller cannot enter is refused like a missing one", async () => {
    const owner = await tool(aliceRw, { url: host("vault") });
    expect(owner.value.repo).toBe("alice/vault");
    const stranger = await tool(bobRw, { url: host("vault") });
    const missing = await tool(bobRw, { url: host("nothing") });
    expect(stranger.error).toBe(missing.error);
  });

  describe("who is working, and what is sealed or archived", () => {
    const start = (issueId: string, actorName: string) => {
      const actor = getUserByName(app.db, actorName)!;
      const repo = getRepo(app.db, "alice", "hello")!;
      const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId, actorId: actor.id, reason: "assigned" });
      claimRun(app.db, run.id);
      return run.id;
    };
    const end = (runId: string) => finishRun(app.db, runId, { state: "ok", summary: "done" });
    const pullIssue = () => getIssue(app.db, getRepo(app.db, "alice", "hello")!.id, pull)!;

    test("a running agent run on the pull is named, and every one is listed", async () => {
      const a = start(pullIssue().id, "bob");
      const b = start(pullIssue().id, "alice");
      const r = await tool(aliceRw, { url: host(`hello--${pull}`) });
      expect([...r.value.working].sort()).toEqual(["alice", "bob"]);
      end(a);
      end(b);
      expect((await tool(aliceRw, { url: host(`hello--${pull}`) })).value.working).toEqual([]);
    });

    test("a run on a sealed issue is left out for who may not view it", async () => {
      const repo = getRepo(app.db, "alice", "hello")!;
      const made = createIssue(app.db, { repoId: repo.id, authorId: getUserByName(app.db, "alice")!.id, title: "secret", kind: "issue" });
      if (!made.ok) throw new Error(made.error);
      setSealed(app.db, made.value.id, true);
      const run = start(made.value.id, "alice");
      expect((await tool(bobRw, { url: host("hello") })).value.working).toEqual([]);
      expect((await tool(aliceRw, { url: host("hello") })).value.working).toEqual(["alice"]);
      end(run);
    });

    test("a sealed pull is refused like a missing page to who may not view it", async () => {
      setSealed(app.db, pullIssue().id, true);
      try {
        const missing = await tool(bobRw, { url: host("nothing") });
        const bob = await tool(bobRw, { url: host(`hello--${pull}`) });
        expect(bob.error).toBe(missing.error);
        const alice = await tool(aliceRw, { url: host(`hello--${pull}`) });
        expect(alice.value.pull).toEqual({ number: pull, title: "Say hello" });
      } finally {
        setSealed(app.db, pullIssue().id, false);
      }
    });

    test("an archived repository's app is refused like a missing page", async () => {
      const repo = getRepo(app.db, "alice", "hello")!;
      app.db.query("UPDATE repo SET archived_at = ?2 WHERE id = ?1").run(repo.id, new Date().toISOString());
      try {
        const missing = await tool(aliceRw, { url: host("nothing") });
        expect((await tool(aliceRw, { url: host("hello") })).error).toBe(missing.error);
      } finally {
        app.db.query("UPDATE repo SET archived_at = NULL WHERE id = ?1").run(repo.id);
      }
      expect((await tool(aliceRw, { url: host("hello") })).value.repo).toBe("alice/hello");
    });
  });
});
