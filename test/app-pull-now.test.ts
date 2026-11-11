/**
 * Pull now (#10084): a writer runs one adapter pull without waiting for its
 * schedule, through the schedule's own path. The action is tried with a fake
 * reach (a writer gets the recorded run; a reader is refused; overlap, no
 * adapter and asleep are refused, and asleep is never reached); the route and
 * the MCP `pull` action are tried on a forge with no app runtime, where every
 * production is asleep and so must be refused without being woken.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { pullNow, PULL_NOW_REFUSALS } from "../src/actions/app_pull.ts";
import type { PullReach, PullReply } from "../src/apps/pull_schedule.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { listPullRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

const good = JSON.stringify({ pulled: 3, skipped: 0, cursor: "c1", errors: 0 });

describe("pull now", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let appId: string;
  let aliceRw: string;
  let bobRw: string;
  let posts = 0;
  let id = 1;

  const reach = (over: Partial<PullReach> = {}): (() => PullReach) => () => ({
    port: () => 4321,
    adapter: async () => ({ schedule: { every: 3600 } }),
    post: async (): Promise<PullReply> => {
      posts += 1;
      return { status: 200, body: good };
    },
    ...over,
  });

  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "app_deploy", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  const post = (token: string, path = "/api/v1/repos/alice/hello/app/pull") =>
    fetch(`${servers.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-pull-now-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
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
    alice = getUserByName(app.db, "alice")!;
    bob = getUserByName(app.db, "bob")!;
    const made = await newApp(app, alice, { name: "hello", visibility: "public" } as never);
    if (!made.ok) throw new Error(String(made.error));
    repo = getRepo(app.db, "alice", "hello")!;
    appId = (app.db.query("SELECT id FROM app WHERE repo_id = ?1").get(repo.id) as { id: string }).id;
    aliceRw = tokenFor(app, "alice", "rw");
    bobRw = tokenFor(app, "bob", "rw");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer gets the recorded run, at once and again, whatever the schedule", async () => {
    const first = await pullNow(app, alice, repo, reach());
    expect(first.ok && first.value).toMatchObject({ appId, kind: "pull", state: "ok", written: 3, cursor: "c1" });
    const again = await pullNow(app, alice, repo, reach());
    expect(again.ok).toBe(true); // inside `every`: the schedule would wait, a pull now does not
    expect(posts).toBe(2);
    expect(listPullRuns(app.db, appId).length).toBe(2);
  });

  test("a reader is refused, and nothing is reached", async () => {
    const before = posts;
    expect(await pullNow(app, bob, repo, reach())).toEqual({ ok: false, error: "forbidden" });
    expect(await pullNow(app, undefined, repo, reach())).toEqual({ ok: false, error: "unauthorized" });
    expect(posts).toBe(before);
  });

  test("a second pull while one is in flight is refused", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow = reach({
      post: async () => {
        await held;
        return { status: 200, body: good };
      },
    });
    const first = pullNow(app, alice, repo, slow);
    await Bun.sleep(5);
    expect(await pullNow(app, alice, repo, reach())).toEqual({ ok: false, error: "in_flight" });
    release();
    expect((await first).ok).toBe(true);
  });

  test("no adapter block and an asleep app are refused; asleep is never asked for its adapter", async () => {
    expect(await pullNow(app, alice, repo, reach({ adapter: async () => undefined }))).toEqual({ ok: false, error: "no_adapter" });
    let asked = false;
    const asleep = reach({
      port: () => undefined,
      adapter: async () => {
        asked = true;
        return { schedule: { every: 60 } };
      },
    });
    expect(await pullNow(app, alice, repo, asleep)).toEqual({ ok: false, error: "asleep" });
    expect(asked).toBe(false);
  });

  test("the route: asleep is 409, a reader 403, no app 404, and nothing is recorded", async () => {
    const before = listPullRuns(app.db, appId).length;
    const asleep = await post(aliceRw);
    expect(asleep.status).toBe(409);
    expect(await asleep.json()).toMatchObject({ error: "asleep", message: PULL_NOW_REFUSALS.asleep });
    expect((await post(bobRw)).status).toBe(403);
    expect((await post(aliceRw, "/api/v1/repos/alice/nothing/app/pull")).status).toBe(404);
    expect(listPullRuns(app.db, appId).length).toBe(before);
  });

  test("the MCP pull action is the same action", async () => {
    const asleep = await mcp(aliceRw, { repo: "alice/hello", action: "pull" });
    expect(asleep.error).toContain("asleep");
    expect(asleep.error).toContain(PULL_NOW_REFUSALS.asleep);
    const reader = await mcp(bobRw, { repo: "alice/hello", action: "pull" });
    expect(reader.error).toContain("forbidden");
  });
});

/**
 * The route and the MCP `pull` action through the real reach
 * (`runtimePullReach`): a registered runtime, never started, says production
 * is running on the port of a loopback `/pull` server; the adapter block is
 * whatever `forge.json` on the default branch says. So each mapping — 200
 * `{ run }`, 404 `no_adapter`, 409 `in_flight` — is driven by the state that
 * earns it, not by a stand-in.
 */
describe("pull now at the route and over MCP, through the real reach", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let adapterApp: ReturnType<typeof Bun.serve>;
  let repo: Repo;
  let appId: string;
  let aliceRw: string;
  let gate: Promise<void> = Promise.resolve();
  let pulls = 0;
  let id = 1;

  const post = () =>
    fetch(`${servers.url}/api/v1/repos/alice/hello/app/pull`, { method: "POST", headers: { authorization: `Bearer ${aliceRw}` } });

  const mcp = async (args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${aliceRw}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "app_deploy", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  const declare = async (forgeJson: unknown) => {
    const c = await commitFiles(repoDir(app.reposRoot, repo.ownerName, repo.name), {
      branch: repo.defaultBranch,
      message: "forge.json",
      files: [{ path: "forge.json", content: JSON.stringify(forgeJson) }],
      author: { name: "T", email: "t@forge.test" },
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-pull-now-route-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const alice = getUserByName(app.db, "alice")!;
    const made = await newApp(app, alice, { name: "hello", visibility: "public" } as never);
    if (!made.ok) throw new Error(String(made.error));
    repo = getRepo(app.db, "alice", "hello")!;
    appId = (app.db.query("SELECT id FROM app WHERE repo_id = ?1").get(repo.id) as { id: string }).id;
    aliceRw = tokenFor(app, "alice", "rw");
    adapterApp = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async () => {
        pulls += 1;
        await gate;
        return Response.json({ pulled: 2, skipped: 1, cursor: "r1", errors: 0 });
      },
    });
    runtime = new AppsRuntime(app, { domain: "pull.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
    spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
      (): EnvStatus => ({ env: "production", state: "running", commitOid: "0".repeat(40), url: "", port: adapterApp.port }) as EnvStatus,
    );
    await declare({ run: "bun run src/server.ts" });
  }, 30_000);

  afterAll(async () => {
    mock.restore();
    await runtime.stop();
    adapterApp.stop(true);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("no adapter block: the route is 404 no_adapter, MCP says the same, and nothing is reached", async () => {
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "no_adapter", message: PULL_NOW_REFUSALS.no_adapter });
    const over = await mcp({ repo: "alice/hello", action: "pull" });
    expect(over.error).toContain("no_adapter");
    expect(over.error).toContain(PULL_NOW_REFUSALS.no_adapter);
    expect(pulls).toBe(0);
  });

  test("an adapter: the route is 200 { run }, and so is MCP", async () => {
    await declare({ run: "bun run src/server.ts", adapter: { schedule: { every: 3600 } } });
    const res = await post();
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.run).toMatchObject({ appId, kind: "pull", state: "ok", written: 2, cursor: "r1" });
    const over = await mcp({ repo: "alice/hello", action: "pull" });
    expect(over.value.run).toMatchObject({ appId, kind: "pull", state: "ok" });
    expect(pulls).toBe(2);
    expect(listPullRuns(app.db, appId).length).toBe(2);
  });

  test("a pull already in flight: the route is 409 in_flight, and so is MCP", async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const before = pulls;
    const first = post();
    while (pulls === before) await Bun.sleep(5);
    const second = await post();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "in_flight", message: PULL_NOW_REFUSALS.in_flight });
    const over = await mcp({ repo: "alice/hello", action: "pull" });
    expect(over.error).toContain("in_flight");
    release();
    gate = Promise.resolve();
    expect((await first).status).toBe(200);
  });
});
