/**
 * The `preview` tool tells an agent what the forge pill tells a person: the
 * app, the environment, the pull, its check, its first failure and its log.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getPull } from "../src/core/pulls.ts";
import { setIssueState } from "../src/core/issues.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { listAt } from "./mcp-list.ts";

describe("MCP preview", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let aliceRw: string;
  let bobRw: string;
  let id = 1;
  const host = (label: string) => `http://${label}.apps.test`;

  const call = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const tool = (token: string, args: unknown) => call(token, "preview", args);

  const makePull = async (alice: any, repo: any, branch: string) => {
    const committed = await commitToBranch(app, alice, repo, {
      branch,
      base: repo.defaultBranch,
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, alice, repo, { title: `Pull ${branch}`, baseBranch: repo.defaultBranch, headBranch: branch });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value.number;
  };

  let redPull = 0;
  let sealedPull = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-preview-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
    await runtime.start();
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    const alice = getUserByName(app.db, "alice")!;
    const made = await newApp(app, alice, { name: "hello", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "hello")!;
    redPull = await makePull(alice, repo, "red");
    sealedPull = await makePull(alice, repo, "secret");
    const pull = getPull(app.db, repo.id, redPull)!;
    const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, commitOid: pull.headOid });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: "1 test failed",
      checkDetail: { passed: 3, failed: 1, names: ["adds two numbers"] },
    });
    const secret = getPull(app.db, repo.id, sealedPull)!;
    app.db.query("UPDATE issue SET sealed = 1 WHERE id = ?1").run(secret.id);
    aliceRw = tokenFor(app, "alice", "rw");
    bobRw = tokenFor(app, "bob", "rw");
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a production URL names the app and no pull", async () => {
    const r = await tool(bobRw, { url: `${host("hello")}/some/page?x=1` });
    expect(r.value).toEqual({
      app: "alice/hello",
      environment: "production",
      pull: null,
      check: null,
      firstFailure: null,
      logUrl: null,
      working: [],
      serving: expect.objectContaining({ state: expect.any(String), says: expect.any(String) }),
    });
  });

  describe("serving", () => {
    let spy: ReturnType<typeof spyOn> | undefined;
    const stub = (status: EnvStatus | undefined) => {
      spy = spyOn(runtime, "envStatus").mockImplementation(() => status);
    };
    afterEach(() => {
      spy?.mockRestore();
      spy = undefined;
    });
    const serving = async (label: string) => (await tool(bobRw, { url: host(label) })).value.serving;
    const base = { env: "production", commitOid: "x", url: "u" } as const;

    test("running", async () => {
      stub({ ...base, state: "running", runId: "r1" } as EnvStatus);
      const s = await serving("hello");
      expect(s.state).toBe("running");
      expect(s.runUrl).toBe(`${servers.url}/runs/r1`);
    });
    test("starting", async () => {
      stub({ ...base, state: "deploying" } as EnvStatus);
      expect(await serving("hello")).toEqual({ state: "starting", says: "A new version is starting.", runUrl: null });
    });
    test("failed carries its error, redacted", async () => {
      stub({ ...base, state: "failed", error: "boom token=ghp_abcdefghijklmnopqrstuvwxyz0123456789", runId: "r2" } as EnvStatus);
      const s = await serving("hello");
      expect(s.state).toBe("failed");
      expect(s.says).toContain("boom");
      expect(s.says).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      expect(s.runUrl).toBe(`${servers.url}/runs/r2`);
    });
    test("production is never gone: not running, then running", async () => {
      stub(undefined);
      const off = await serving("hello");
      expect(off.state).toBe("not_running");
      expect(off.says).toBe("Nothing is running here yet.");
      spy?.mockRestore();
      stub({ ...base, state: "running" } as EnvStatus);
      expect((await serving("hello")).state).toBe("running");
    });
    test("not running: an open pull with nothing deployed is never gone", async () => {
      stub(undefined);
      const s = await serving(`hello--${redPull}`);
      expect(s.state).toBe("not_running");
      expect(s.says).toContain("starts again with the next push");
    });
    test("gone: a closed pull", async () => {
      stub(undefined);
      const repo = getRepo(app.db, "alice", "hello")!;
      const n = await makePull(getUserByName(app.db, "alice")!, repo, "closing");
      setIssueState(app.db, getPull(app.db, repo.id, n)!.id, "closed");
      const s = await serving(`hello--${n}`);
      expect(s.state).toBe("gone");
      expect(s.says).toContain("This preview is gone");
    });
  });

  test("a preview URL with a red check says the pull, the failure and the log", async () => {
    const r = await tool(bobRw, { url: host(`hello--${redPull}`) });
    expect(r.value.environment).toBe(`pull-${redPull}`);
    expect(r.value.pull).toEqual({ number: redPull, title: "Pull red" });
    expect(r.value.check).toBe("red");
    expect(r.value.firstFailure).toBe("adds two numbers");
    // The log is a writer's: a reader gets the failure but not the link.
    expect(r.value.logUrl).toBeNull();
    const owner = await tool(aliceRw, { url: host(`hello--${redPull}`) });
    expect(owner.value.logUrl).toMatch(/\/alice\/hello\/runs\/[^/]+$/);
  });

  test("working names the agents on this pull, not on another, and not on a sealed issue for bob", async () => {
    const repo = getRepo(app.db, "alice", "hello")!;
    const agent = await createUser(app.db, { origin: "seed", trusted: true, username: "worker", email: "worker@forge.local", password: "a-good-passphrase" });
    if (!agent.ok) throw new Error(agent.error);
    const start = (issueId: string) => {
      const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId, actorId: agent.value.id });
      claimRun(app.db, run.id);
    };
    const ids = (n: number) => getPull(app.db, repo.id, n)!.id;
    start(ids(sealedPull));
    // Only a run on a sealed issue is active: bob learns of none, alice does.
    expect((await tool(bobRw, { url: host("hello") })).value.working).toEqual([]);
    expect((await tool(aliceRw, { url: host("hello") })).value.working).toEqual(["worker"]);
    expect((await tool(bobRw, { url: host(`hello--${redPull}`) })).value.working).toEqual([]);
    expect((await tool(aliceRw, { url: host(`hello--${redPull}`) })).value.working).toEqual([]);
    start(ids(redPull));
    expect((await tool(bobRw, { url: host(`hello--${redPull}`) })).value.working).toEqual(["worker"]);
    expect((await tool(bobRw, { url: host("hello") })).value.working).toEqual(["worker"]);
    expect((await tool(aliceRw, { url: host(`hello--${sealedPull}`) })).value.working).toEqual(["worker"]);
  });

  test("a host that is not an app host of this forge is refused", async () => {
    for (const url of ["https://example.com/", "not a url", "http://nothing.apps.test/", "ftp://hello.apps.test/"]) {
      const r = await tool(bobRw, { url });
      expect(r.error).toBeDefined();
    }
    expect((await tool(bobRw, { url: "https://example.com/" })).error).toContain("`url` is one of this forge's app hosts");
  });

  test("a pull the caller cannot see is 'no pull', as the pull tool says", async () => {
    const seen = await tool(aliceRw, { url: host(`hello--${sealedPull}`) });
    expect(seen.value.pull.number).toBe(sealedPull);
    const hidden = await tool(bobRw, { url: host(`hello--${sealedPull}`) });
    expect(hidden.error).toContain(`no pull #${sealedPull}`);
    const viaPull = await call(bobRw, "pull", { repo: "alice/hello", number: sealedPull });
    expect(viaPull.error).toBe(hidden.error);
  });

  test("it is listed in tools/list", async () => {
    const body = await listAt(servers.url, bobRw);
    expect(body.result.tools.some((t: any) => t.name === "preview")).toBe(true);
  });
});
