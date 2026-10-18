import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { listSessions } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

// #1460: with no platform edge configured the forge alone issues and checks
// every session, and an edge header never grants access.
describe("a forge with no platform edge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  const signIn = async () => {
    const r = await fetch(`${base}/signin`, {
      method: "POST",
      headers: { origin: "https://forge.example" },
      body: new URLSearchParams({ username: "olive", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return r;
  };
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers, redirect: "manual" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-own-session-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    base = servers.url;
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "olive",
      email: "olive@f.dev",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: made.value.id,
      name: "vault",
      visibility: "private",
    });
    if (!repo.ok) throw new Error(repo.error);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the session cookie is HttpOnly, SameSite, and Secure for an https forge", async () => {
    const r = await signIn();
    expect(r.status).toBe(303);
    const cookie = r.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  test("a private page needs the forge's own session", async () => {
    const cookie = (await signIn()).headers.get("set-cookie")!.split(";")[0]!;
    for (const path of ["/olive/vault", "/settings/accounts"]) {
      const anon = await get(path);
      expect(anon.status).not.toBe(200);
      expect(await anon.text()).not.toContain("vault</");
      const authed = await get(path, { cookie });
      expect(authed.status).toBe(200);
    }
    expect(await (await get("/olive/vault", { cookie })).text()).toContain("vault");
  });

  test("edge headers grant nothing when no edge is configured", async () => {
    const forged = { "x-plat-user": "olive", "x-plat-edge-token": "anything" };
    expect((await get("/olive/vault", forged)).status).not.toBe(200);
    expect((await get("/settings/accounts", forged)).status).not.toBe(200);
  });

  test("a session revoked by its owner is refused on the next request", async () => {
    const cookie = (await signIn()).headers.get("set-cookie")!.split(";")[0]!;
    expect((await get("/olive/vault", { cookie })).status).toBe(200);
    const user = app.db.query<{ id: string }, []>("SELECT id FROM user").get()!;
    const id = listSessions(app.db, user.id, cookie.split("=")[1]).find((s) => s.current)!.id;
    const ended = await fetch(`${base}/settings/accounts/olive/sessions/${id}/delete`, {
      method: "POST",
      headers: { cookie, origin: "https://forge.example" },
      body: new URLSearchParams({}),
      redirect: "manual",
    });
    expect(ended.status).toBe(303);
    expect((await get("/olive/vault", { cookie })).status).not.toBe(200);
  });
});
