/**
 * The `sync` tool is POST …/sync and …/origin/reconnect over MCP: the same
 * actions, the same refusals, a faked origin and no network.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createOrigin } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { mirrorAndWait, newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";

setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-origin-secret-9d2f";
const PASSWORD = "alice-login-secret";
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("MCP sync", () => {
  let dirs: string[] = [];
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let adminTok: string;
  let rwTok: string;
  let readerTok: string;
  let id = 1;
  let firstOrigin = "";

  const rpc = async (token: string, args: unknown) => {
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
        params: { name: "sync", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    return { text: String(body.result?.content?.[0]?.text ?? ""), isError: body.result?.isError === true };
  };

  beforeAll(async () => {
    for (const p of ["forge-mcpsync-", "forge-mcpsync-up-"]) dirs.push(await mkdtemp(join(tmpdir(), p)));
    originApp = createApp({ dataDir: dirs[1]!, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, { username: LOGIN, email: "octo@up.test", password: TOKEN });
    const oh = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ name: "sprockets", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/sprockets/contents`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ branch: "main", message: "first", files: [{ path: "a.txt", content: "one\n" }] }),
    });
    const state = newFakeState("github", LOGIN, TOKEN);
    state.repos.push({
      id: 5,
      fullName: "octo/sprockets",
      cloneUrl: `${originServers.url}/octo/sprockets.git`,
      defaultBranch: "main",
      htmlUrl: `${originServers.url}/octo/sprockets`,
    });
    fake = serveFakeForge(state);
    // The repository's page lives on the origin's own site; a reconnect compares sites.
    state.repos[0]!.htmlUrl = `${fake.url}/octo/sprockets`;

    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    const alice = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    if (!alice.ok) throw new Error(alice.error);
    const aliceUser = alice.value;
    const api = (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("content-type", "application/json");
      headers.set("authorization", basic("alice", PASSWORD));
      return fetch(`${servers.url}${path}`, { ...init, headers });
    };
    const connected = (await (
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, kind: "github", token: TOKEN }),
      })
    ).json()) as { id: string };
    firstOrigin = connected.id;
    await mirrorAndWait(
      await api(`/api/v1/user/origins/${connected.id}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "octo/sprockets" }),
      }),
    );
    proveAll(app);
    const made = await createRepo(app, aliceUser, { name: "plain", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const a = getUserByName(app.db, "alice")!;
    adminTok = createToken(app.db, a.id, "admin", "admin").token;
    rwTok = createToken(app.db, a.id, "rw", "rw").token;
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    readerTok = createToken(app.db, b.value.id, "rw", "rw").token;
  });

  afterAll(async () => {
    await syncsSettled();
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  test("an admin starts a sync of a mirror", async () => {
    const r = await rpc(adminTok, { repo: "alice/sprockets" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Synced");
  });

  test("a non-mirror is refused as the API refuses", async () => {
    const r = await rpc(adminTok, { repo: "alice/plain" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_found");
  });

  test("a reader is refused", async () => {
    const r = await rpc(readerTok, { repo: "alice/sprockets" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("write access");
  });

  test("an attached mirror is not frozen, and reconnecting says so", async () => {
    const r = await rpc(adminTok, { repo: "alice/sprockets", originId: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_detached");
    expect(r.text).toContain("sync it without originId");
  });

  test("a native fork is not a mirror: take_updates", async () => {
    const parent = getRepo(app.db, "alice", "plain")!;
    const forked = await forkRepo(app, getUserByName(app.db, "alice"), parent, "plain-fork");
    if (!forked.ok) throw new Error(String(forked.error));
    const r = await rpc(adminTok, { repo: "alice/plain-fork" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_a_mirror");
    expect(r.text).toContain("take_updates");
  });

  test("reconnecting needs an admin-scope token", async () => {
    const r = await rpc(rwTok, { repo: "alice/sprockets", originId: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("admin-scope");
  });

  test("a frozen mirror is reconnected to a new origin of the same account", async () => {
    const api = (path: string, init?: RequestInit) =>
      fetch(`${servers.url}${path}`, {
        ...init,
        headers: { "content-type": "application/json", authorization: basic("alice", PASSWORD) },
      });
    const gone = await api(`/api/v1/user/origins/${firstOrigin}`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    const before = (await (await api("/api/v1/repos/alice/sprockets")).json()) as any;
    expect(before.origin.detached).toBe(true);
    // A row made directly, not through a connect, which would reattach by itself.
    const made = createOrigin(app.db, app.config.dataDir, {
      userId: getUserByName(app.db, "alice")!.id,
      kind: "github",
      apiUrl: fake.url,
      webUrl: fake.url,
      login: LOGIN,
      token: TOKEN,
    });
    if (!made.ok) throw new Error(made.error);
    const again = { id: made.value.id };

    const unknown = await rpc(adminTok, { repo: "alice/sprockets", originId: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("not_found");

    const r = await rpc(adminTok, { repo: "alice/sprockets", originId: again.id });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Reconnected octo/sprockets");
    await syncsSettled();
    const after = (await (await api("/api/v1/repos/alice/sprockets")).json()) as any;
    expect(after.origin.detached).toBe(false);
  });
});
