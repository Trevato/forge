/**
 * The `signup` forge setting (#2165): open by default, an admin changes it
 * live from the API, the MCP tool and the page, a bad value is a 422, a
 * non-admin is refused, FORGE_SIGNUP is checked at boot, every change is kept.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { configProblem } from "../src/kernel/preflight.ts";
import { BOOT_ACTOR, getSignup, setSignup, signupChanges, signupFromEnv } from "../src/settings/signup.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("signup setting", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signup-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const username of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") alice = made.value;
      else bob = made.value;
    }
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const api = (token: string, method: string, body?: unknown) =>
    fetch(`${servers.url}/api/v1/admin/settings`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const mcp = async (token: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "signup", arguments: args },
      }),
    });
    return res.text();
  };

  test("defaults to open; the API sets it live and the audit row names who", async () => {
    const t = createToken(app.db, alice.id, "t", "admin").token;
    expect(getSignup(app.db)).toBe("open");
    const set = await api(t, "PATCH", { signup: "closed" });
    expect(set.status).toBe(200);
    expect(getSignup(app.db)).toBe("closed");
    const changes = signupChanges(app.db);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: "open", to: "closed", actorName: "alice" });
    const read = (await (await api(t, "GET")).json()) as {
      signup: string;
      signupChanges: { from: string; to: string; actorName: string }[];
    };
    expect(read.signup).toBe("closed");
    expect(read.signupChanges).toHaveLength(1);
    expect(read.signupChanges[0]).toMatchObject({ from: "open", to: "closed", actorName: "alice" });
    // The same mode again keeps nothing.
    await api(t, "PATCH", { signup: "closed" });
    expect(signupChanges(app.db)).toHaveLength(1);
  });

  test("any other value is a 422 and changes nothing", async () => {
    const t = createToken(app.db, alice.id, "t", "admin").token;
    for (const bad of ["Closed", "", "nope", 1, null, ["open"]]) {
      const res = await api(t, "PATCH", { signup: bad });
      expect(res.status).toBe(422);
    }
    expect(getSignup(app.db)).toBe("closed");
  });

  test("a non-admin is refused", async () => {
    const t = createToken(app.db, bob.id, "t", "admin").token;
    const res = await api(t, "PATCH", { signup: "open" });
    expect(res.status).toBe(404);
    expect(getSignup(app.db)).toBe("closed");
  });

  test("the MCP tool is dry by default and sets it with dryRun false", async () => {
    const t = createToken(app.db, alice.id, "t", "admin").token;
    await mcp(t, { mode: "invite" });
    expect(getSignup(app.db)).toBe("closed");
    await mcp(t, { mode: "invite", dryRun: false });
    expect(getSignup(app.db)).toBe("invite");
    await mcp(t, { mode: "bogus", dryRun: false });
    expect(getSignup(app.db)).toBe("invite");
    const b = createToken(app.db, bob.id, "t", "admin").token;
    await mcp(b, { mode: "open", dryRun: false });
    expect(getSignup(app.db)).toBe("invite");
  });

  test("the admin page sets it, refuses a cross-origin post and a non-admin, and lists the change", async () => {
    const aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
    const post = (cookie: string, signup: string, origin: string) =>
      fetch(`${servers.url}/admin/signup`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
        body: new URLSearchParams({ signup }),
      });
    // Before: invite (set through MCP above).
    expect((await post(aliceCookie, "closed", "https://evil.example")).status).toBe(403);
    expect(getSignup(app.db)).toBe("invite");
    expect((await post(bobCookie, "closed", servers.url)).status).toBe(404);
    expect(getSignup(app.db)).toBe("invite");
    await post(aliceCookie, "nope", servers.url);
    expect(getSignup(app.db)).toBe("invite");
    app.db.run("DELETE FROM forge_setting WHERE key = 'signup'");
    const res = await post(aliceCookie, "invite", servers.url);
    expect(res.status).toBe(303);
    expect(getSignup(app.db)).toBe("invite");
    const text = await (await fetch(`${servers.url}/admin/limits`, { headers: { cookie: aliceCookie } })).text();
    expect(text).toMatch(/<option value="invite"\s+selected/);
    expect(text).toContain("alice");
  });

  test("FORGE_SIGNUP: unset is no opinion, a wrong value stops the boot, boot is kept", () => {
    expect(signupFromEnv(undefined)).toEqual({ ok: true, value: null });
    expect(signupFromEnv(" invite ")).toEqual({ ok: true, value: "invite" });
    const bad = signupFromEnv("wide-open");
    expect(bad.ok).toBe(false);
    expect(configProblem({ FORGE_SIGNUP: "wide-open" }, "/nowhere")).toContain("FORGE_SIGNUP");
    expect(configProblem({ FORGE_SIGNUP: "closed" }, "/nowhere")).toBeNull();
    setSignup(app.db, "open", BOOT_ACTOR);
    expect(getSignup(app.db)).toBe("open");
    expect(signupChanges(app.db)[0]).toMatchObject({ to: "open", actorName: "FORGE_SIGNUP at boot" });
  });
});
