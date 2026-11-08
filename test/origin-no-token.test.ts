/**
 * An origin with no stored token (#7177): `credentialFor` answers `no_token`.
 * A sync through it is a refusal that says to reconnect, in words — through
 * the API, through MCP `sync`, and on the origin's settings page — and the
 * mirror's refs do not move.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { mirrorAndWait, newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

setDefaultTimeout(60_000);

const LOGIN = "octo";
const TOKEN = "octo-origin-secret-3b7e";
const PASSWORD = "alice-login-secret";
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("syncing a mirror whose origin has no stored token", () => {
  const dirs: string[] = [];
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let adminTok = "";
  let originId = "";

  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", PASSWORD));
    return fetch(`${servers.url}${path}`, { ...init, headers });
  };
  const mirrorMain = () => resolveOid(repoDir(app.reposRoot, "alice", "vault"), "refs/heads/main");
  const upstreamDir = () => repoDir(originApp.reposRoot, LOGIN, "vault");

  const mcpSync = async (args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${adminTok}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "sync", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    return { text: String(body.result?.content?.[0]?.text ?? ""), isError: body.result?.isError === true };
  };

  beforeAll(async () => {
    for (const p of ["forge-notoken-", "forge-notoken-up-"]) dirs.push(await mkdtemp(join(tmpdir(), p)));
    originApp = createApp({ dataDir: dirs[1]!, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, { username: LOGIN, email: "octo@up.test", password: TOKEN });
    const oh = { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) };
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ name: "vault", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/vault/contents`, {
      method: "POST",
      headers: oh,
      body: JSON.stringify({ branch: "main", message: "first", files: [{ path: "a.txt", content: "one\n" }] }),
    });
    const state = newFakeState("github", LOGIN, TOKEN);
    state.repos.push({
      id: 9,
      fullName: "octo/vault",
      private: true,
      cloneUrl: `${originServers.url}/octo/vault.git`,
      defaultBranch: "main",
      htmlUrl: `${originServers.url}/octo/vault`,
    });
    fake = serveFakeForge(state);

    app = createApp({ dataDir: dirs[0]!, port: 0 });
    servers = await serve(app);
    const alice = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
    if (!alice.ok) throw new Error(alice.error);
    const connected = (await (
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, kind: "github", token: TOKEN }),
      })
    ).json()) as { id: string };
    originId = connected.id;
    await mirrorAndWait(
      await api(`/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "octo/vault" }),
      }),
    );
    proveAll(app);
    adminTok = createToken(app.db, getUserByName(app.db, "alice")!.id, "admin", "admin").token;
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

  test("the sealed secret is removed, the upstream moves, and every sync says to reconnect", async () => {
    const before = await mirrorMain();
    expect(before).toBeDefined();

    // The sealed secret is gone; the origin row is not.
    app.db.query("UPDATE origin SET token_enc = '', refresh_token_enc = '' WHERE id = ?1").run(originId);

    // The upstream moves on, so an unchanged mirror proves nothing was fetched.
    await fetch(`${originServers.url}/api/v1/repos/octo/vault/contents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) },
      body: JSON.stringify({ branch: "main", message: "second", files: [{ path: "b.txt", content: "two\n" }] }),
    });
    expect(await resolveOid(upstreamDir(), "refs/heads/main")).not.toBe(before);

    const viaApi = await api("/api/v1/repos/alice/vault/sync", { method: "POST" });
    expect(viaApi.status).toBeLessThan(500);
    const report = (await viaApi.json()) as { error: string };
    expect(report.error).toContain("reconnect");

    const viaOrigin = await api(`/api/v1/user/origins/${originId}/sync`, { method: "POST" });
    expect(viaOrigin.status).toBeLessThan(500);
    expect(((await viaOrigin.json()) as { error: string }).error).toContain("reconnect");

    const viaMcp = await mcpSync({ repo: "alice/vault" });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.text).toContain("sync_failed");
    expect(viaMcp.text).toContain("reconnect");

    expect(await mirrorMain()).toBe(before!);
  });

  test("the origin's settings page shows the same reconnect line", async () => {
    const page = (await (await api("/settings/origins")).text()).replace(/\s+/g, " ");
    expect(page).toContain("this origin needs to be reconnected");
    expect(page).toContain("Re-authorize octo");
  });
});
