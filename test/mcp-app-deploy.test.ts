/**
 * The `app_deploy` tool is the API's redeploy and stop over MCP: the same
 * actions, so the same gate. A writer queues and stops, a reader is refused,
 * and an unknown environment is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { envRefusalText } from "../src/actions/env_words.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

describe("MCP app_deploy", () => {
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
        params: { name: "app_deploy", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  const runCount = (): number =>
    (app.db.query("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;

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
    aliceRw = tokenFor(app, "alice", "rw");
    bobRw = tokenFor(app, "bob", "rw");
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer queues a redeploy, and stops production", async () => {
    const r = await tool(aliceRw, { repo: "alice/hello", env: "production", action: "redeploy" });
    expect(r.value.queued).toBe(true);
    expect(typeof r.value.run).toBe("string");
    const s = await tool(aliceRw, { repo: "alice/hello", env: "production", action: "stop" });
    expect(s.value).toEqual({ stopped: true });
  }, 30_000);

  test("a writer stops a pull's preview", async () => {
    const s = await tool(aliceRw, { repo: "alice/hello", env: `pull-${pull}`, action: "stop" });
    expect(s.value).toEqual({ stopped: true });
  }, 30_000);

  test("a reader is refused, and nothing is queued", async () => {
    const before = runCount();
    const r = await tool(bobRw, { repo: "alice/hello", env: "production", action: "redeploy" });
    expect(r.error).toContain("forbidden");
    const s = await tool(bobRw, { repo: "alice/hello", env: "production", action: "stop" });
    expect(s.error).toContain("forbidden");
    expect(runCount()).toBe(before);
  });

  test("an env that is neither production nor pull-N is refused, and nothing is queued", async () => {
    const before = runCount();
    for (const env of ["staging", "pull-x", "pull-", "../production", ""]) {
      const e = await tool(aliceRw, { repo: "alice/hello", env, action: "redeploy" });
      expect(e.error).toContain("no_such_env");
    }
    expect(runCount()).toBe(before);
  });

  test("restart and other actions are invalid_action, and nothing is queued", async () => {
    const before = runCount();
    for (const action of ["restart", "burn", "", "REDEPLOY"]) {
      const a = await tool(aliceRw, { repo: "alice/hello", env: "production", action });
      expect(a.error).toContain("invalid_action");
    }
    expect(runCount()).toBe(before);
  });

  test("a refusal is said in the deploys page's words, the code unchanged", async () => {
    for (const action of ["redeploy", "stop"]) {
      const gone = await tool(aliceRw, { repo: "alice/nothing", env: "production", action });
      expect(gone.error).toContain("no such app or repository");
      const reader = await tool(bobRw, { repo: "alice/hello", env: "production", action });
      expect(reader.error).toContain("forbidden");
      expect(reader.error).toContain(envRefusalText("forbidden"));
      const env = await tool(aliceRw, { repo: "alice/hello", env: "staging", action });
      expect(env.error).toContain("no_such_env");
      expect(env.error).toContain(envRefusalText("no_such_env"));
    }
    expect(envRefusalText("not_found")).toBe("This repository has no app.");
  });
});
