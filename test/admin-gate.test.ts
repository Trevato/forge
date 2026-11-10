/**
 * The admin gate (`src/http/admin_gate.ts`): which paths it guards, and that a
 * person without `administer` is refused with one plain sentence before any
 * admin handler runs, while a guest of `/releases.json` and an admin pass.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { NOT_AN_ADMIN, setMember } from "../src/core/roles.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { adminGate, isAdminPath } from "../src/http/admin_gate.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("isAdminPath", () => {
  test("is true for the guarded paths and their children", () => {
    for (const p of [
      "/admin",
      "/admin/limits",
      "/api/v1/admin",
      "/api/v1/admin/capacity",
      "/releases",
      `/releases/${"a".repeat(40)}/rollback`,
    ])
      expect(isAdminPath(p), p).toBe(true);
  });

  test("is false for look-alikes", () => {
    for (const p of ["/administer", "/api/v1/adminx", "/releases.json", "/", "/api/v1/releases", "/adminx/y"])
      expect(isAdminPath(p), p).toBe(false);
  });
});

describe("the admin gate", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User; // admin
  let carol: User; // member: no `administer`
  let dave: User; // guest: no `administer`

  const mk = async (username: string, admin = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      ...(admin ? { adminIfFirst: true } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const bearer = (u: User) => `Bearer ${createToken(app.db, u.id, "admin", "admin").token}`;
  const api = (method: string, path: string, u: User) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: bearer(u) },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
  const browse = (method: string, path: string, cookie: string) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { cookie, origin: servers.url, accept: "text/html" },
      ...(method === "POST" ? { body: new URLSearchParams({}) } : {}),
      redirect: "manual",
    });
  const cookieOf = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;

  /** Every table's row count, so a refused write is seen as no change. */
  const counts = (): Record<string, number> => {
    const names = app.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    const out: Record<string, number> = {};
    for (const { name } of names)
      out[name] = (app.db.query(`SELECT count(*) AS n FROM "${name}"`).get() as { n: number }).n;
    return out;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-admin-gate-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = await mk("alice", true);
    carol = await mk("carol");
    dave = await mk("dave");
    setMember(app.db, carol.id, true, alice.id, new Date(0));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("adminGate refuses a person without administer and lets everyone else carry on", async () => {
    const auth = (user: User | undefined) => ({ user, scope: undefined, via: "none" as const });
    const ask = (path: string, user: User | undefined) =>
      adminGate(app, new Request(`http://x${path}`), new URL(`http://x${path}`), auth(user));
    expect(ask("/api/v1/admin/capacity", carol)?.status).toBe(403);
    expect(ask("/releases", dave)?.status).toBe(403);
    expect(ask("/api/v1/admin/capacity", alice)).toBeUndefined();
    expect(ask("/api/v1/admin/capacity", undefined)).toBeUndefined();
    expect(ask("/administer", carol)).toBeUndefined();
    expect(ask("/releases.json", dave)).toBeUndefined();
  });

  test("the API answers 403 JSON with one sentence", async () => {
    for (const u of [carol, dave]) {
      const res = await api("GET", "/api/v1/admin/settings", u);
      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: "not_admin", message: NOT_AN_ADMIN });
    }
  });

  test("a browser gets a 403 page with the same sentence", async () => {
    for (const u of [carol, dave]) {
      for (const path of ["/admin/limits", "/releases"]) {
        const res = await browse("GET", path, cookieOf(u));
        expect(res.status, path).toBe(403);
        expect(res.headers.get("content-type")).toContain("text/html");
        const body = await res.text();
        expect(body).toContain("<h1>You can't do that here</h1>");
        expect(body).toContain(NOT_AN_ADMIN.replace("'", "&#39;"));
      }
    }
  });

  test("a refused POST to a rollback or an admin form writes nothing", async () => {
    const cookie = cookieOf(carol);
    const before = counts();
    for (const path of [`/releases/${"a".repeat(40)}/rollback`, "/admin/limits", "/admin/signup"]) {
      const res = await browse("POST", path, cookie);
      expect(res.status, path).toBe(403);
    }
    const res = await api("POST", "/api/v1/admin/invites", carol);
    expect(res.status).toBe(403);
    expect(counts()).toEqual({ ...before, token: before["token"]! + 1 });
  });

  test("/releases.json answers a guest and a signed-out caller", async () => {
    expect((await fetch(`${servers.url}/releases.json`)).status).toBe(200);
    const res = await fetch(`${servers.url}/releases.json`, { headers: { authorization: bearer(dave) } });
    expect(res.status).toBe(200);
  });

  test("an admin reaches the handlers unchanged", async () => {
    expect((await api("GET", "/api/v1/admin/settings", alice)).status).toBe(200);
    expect((await browse("GET", "/admin/limits", cookieOf(alice))).status).toBe(200);
    expect((await browse("GET", "/releases", cookieOf(alice))).status).toBe(200);
  });
});
