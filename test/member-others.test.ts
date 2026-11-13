/**
 * Roles, part 3b-i (#2421): a member cannot change another account, and is
 * refused as quotas and accounts refuse a non-admin: the admin gate's 403 under
 * /api/v1/admin, and 404 (the door is not there) on the account pages and routes.
 * A member still changes their own account.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { SIGN_IN_AS_ADMIN } from "../src/core/roles.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession, listSessions } from "../src/core/sessions.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { fixtureSlot } from "./helpers/slot.ts";

quietLogs();

const PASS = "a-long-member-passphrase";

describe("a member and another account", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let bob: NonNullable<ReturnType<typeof getUserByName>>;
  let bobToken = "";
  let carolBefore = "";

  const call = (path: string, token: string, method = "GET", body?: unknown) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const person = async (username: string) => {
    const made = await signUp(app, { username, email: `${username}@f.dev`, password: PASS }, { slot: fixtureSlot(app) });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-member-others-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    await person("olive");
    const b = await person("bob");
    const c = await person("carol");
    promote(app.db, b, c);
    bob = getUserByName(app.db, "bob")!;
    bobToken = createToken(app.db, b.id, "t", "admin").token;
    carolBefore = JSON.stringify(getUserByName(app.db, "carol"));
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a member is refused on another account, by every API route", async () => {
    const carol = getUserByName(app.db, "carol")!;
    createSession(app.db, carol.id);
    const sid = listSessions(app.db, carol.id)[0]!.id;
    const laptop = createToken(app.db, carol.id, "laptop", "rw");
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/v1/admin/accounts"],
      ["GET", "/api/v1/admin/people"],
      ["POST", "/api/v1/admin/accounts/carol/suspend"],
      ["POST", "/api/v1/admin/accounts/carol/unsuspend"],
      ["POST", "/api/v1/admin/accounts/carol/verify"],
      ["POST", "/api/v1/admin/accounts/carol/role", { role: "guest" }],
      ["POST", "/api/v1/admin/accounts/carol/model-grant", { usdPerMonth: 5 }],
      ["POST", "/api/v1/admin/accounts/carol/ceiling", { dailyUsd: 1, perRunUsd: 1 }],
      ["DELETE", "/api/v1/admin/accounts/carol", {}],
      ["GET", "/api/v1/users/carol/signins"],
      ["DELETE", `/api/v1/users/carol/sessions/${sid}`],
    ];
    // Under /api/v1/admin the admin gate speaks (403, its words); an account's
    // own sign-ins are not an admin surface, so the door is simply not there.
    for (const [method, path, body] of routes) {
      const res = await call(path, bobToken, method, body);
      const gated = path.startsWith("/api/v1/admin/");
      expect([method, path, res.status]).toEqual([method, path, gated ? 403 : 404]);
      if (gated) expect(await res.json()).toMatchObject({ error: "not_admin", message: SIGN_IN_AS_ADMIN });
    }
    expect(listSessions(app.db, carol.id).some((s) => s.id === sid)).toBe(true);
    // Carol's token: not listed, not revoked through bob's own token routes.
    expect(await (await call("/api/v1/tokens", bobToken)).text()).not.toContain(laptop.id);
    expect((await call(`/api/v1/tokens/${laptop.id}`, bobToken, "DELETE")).status).not.toBe(204);
    expect((await call("/api/v1/user", laptop.token)).status).toBe(200);
    expect(JSON.stringify(getUserByName(app.db, "carol"))).toBe(carolBefore);
  });

  test("a member is refused on the web forms too, and nothing changes", async () => {
    const carol = getUserByName(app.db, "carol")!;
    const laptop = createToken(app.db, carol.id, "phone", "rw");
    createSession(app.db, carol.id);
    const sid = listSessions(app.db, carol.id)[0]!.id;
    const cookie = `forge_session=${createSession(app.db, bob.id).token}`;
    const post = (path: string, form: Record<string, string> = {}) =>
      fetch(`${servers.url}${path}`, {
        method: "POST",
        headers: { cookie, origin: "https://forge.example" },
        body: new URLSearchParams(form),
        redirect: "manual",
      });
    const forms: [string, Record<string, string>][] = [
      ["/settings/people/carol/role", { role: "guest" }],
      ["/settings/accounts/carol/model", { usd: "5" }],
      ["/settings/accounts/carol/ceiling", { daily: "1", perRun: "1" }],
      ["/settings/accounts/carol/suspend", {}],
      ["/settings/accounts/carol/unsuspend", {}],
      ["/settings/accounts/carol/verify", {}],
      ["/settings/accounts/carol/remove", {}],
      [`/settings/accounts/carol/tokens/${laptop.id}/delete`, {}],
      [`/settings/accounts/carol/sessions/${sid}/delete`, {}],
    ];
    for (const [path, form] of forms)
      expect([path, (await post(path, form)).status]).toEqual([path, 403]);
    const page = await fetch(`${servers.url}/settings/accounts/carol`, { headers: { cookie } });
    expect(page.status).toBe(403);
    expect((await call("/api/v1/user", laptop.token)).status).toBe(200);
    expect(listSessions(app.db, carol.id).some((s) => s.id === sid)).toBe(true);
    expect(JSON.stringify(getUserByName(app.db, "carol"))).toBe(carolBefore);
  });

  test("a member's profile and password calls change only their own account", async () => {
    // Naming another account in the body does not reach it.
    const res = await call("/api/v1/user", bobToken, "PATCH", { displayName: "Bobby", username: "carol" });
    expect(res.status).toBe(200);
    expect(getUserByName(app.db, "bob")!.displayName).toBe("Bobby");
    expect(getUserByName(app.db, "carol")!.displayName).not.toBe("Bobby");
    const pw = await call("/api/v1/user/password", bobToken, "POST", { current: "wrong-password-1", next: "another-long-passphrase", username: "carol" });
    expect(pw.status).toBe(403);
    expect(JSON.stringify(getUserByName(app.db, "carol"))).toBe(carolBefore);
  });

  test("a member succeeds on their own account", async () => {
    expect((await call("/api/v1/users/bob/signins", bobToken)).status).toBe(200);
    createSession(app.db, bob.id);
    const sid = listSessions(app.db, bob.id)[0]!.id;
    expect((await call(`/api/v1/users/bob/sessions/${sid}`, bobToken, "DELETE")).status).toBe(204);
    const pw = await call("/api/v1/user/password", bobToken, "POST", { current: PASS, next: "another-long-passphrase" });
    expect(pw.status).toBe(200);
  });
});
