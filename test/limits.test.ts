/**
 * Every limit is a setting with its reason beside it (#1476): a forge
 * admin lists and changes them on /admin/limits, a value out of bounds is
 * refused with its bound named, each change is kept, and a changed limit
 * changes what it governs on the very next use. Anyone else gets a 404.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { setFront } from "../src/actions/front.ts";
import { capacityCount } from "../src/core/capacity.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  LIMITS,
  LIMIT_KEYS,
  limitChanges,
  limitValue,
} from "../src/settings/limits.ts";

describe("limits", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;

  const login = async (username: string, password = "a-good-passphrase") => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: servers.url,
      },
      body: new URLSearchParams({ username, password }),
    });
    return {
      status: res.status,
      cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
      text: await res.text(),
    };
  };
  const post = (cookie: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}/admin/limits`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      body: new URLSearchParams(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-limits-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, first] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
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

  test("a non-admin, signed in or not, gets a 404 and changes nothing", async () => {
    const bob = (await login("bob")).cookie;
    for (const cookie of [bob, ""]) {
      const got = await fetch(`${servers.url}/admin/limits`, { headers: { cookie } });
      expect(got.status).toBe(404);
      expect((await post(cookie, { key: "front.pinned_max", value: "50" })).status).toBe(404);
    }
    expect(limitValue(app.db, "front.pinned_max")).toBe(LIMITS["front.pinned_max"].default);
    expect(limitChanges(app.db)).toEqual([]);
  });

  test("the page lists every limit with its value and its reason", async () => {
    const { cookie } = await login("alice");
    const res = await fetch(`${servers.url}/admin/limits`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const key of LIMIT_KEYS) {
      expect(text).toContain(key);
      expect(text).toContain(LIMITS[key].reason.replace(/'/g, "&#39;"));
    }
  });

  test("a value out of bounds is refused with its bound named; a cross-origin post is refused", async () => {
    const { cookie } = await login("alice");
    const def = LIMITS["front.pinned_max"];
    for (const value of [String(def.max + 1), "0", "-3", "1.5", "lots", ""]) {
      const res = await post(cookie, { key: "front.pinned_max", value });
      expect(res.status).toBe(303);
      const flashed = await fetch(`${servers.url}${res.headers.get("location")}`, {
        headers: { cookie: `${cookie}; ${(res.headers.get("set-cookie") ?? "").split(";")[0]}` },
      });
      expect(await flashed.text()).toContain(`from ${def.min} to ${def.max}`);
    }
    expect(limitValue(app.db, "front.pinned_max")).toBe(def.default);
    expect((await post(cookie, { key: "front.pinned_max", value: "20" }, "https://evil.example")).status).toBe(403);
    expect(limitValue(app.db, "front.pinned_max")).toBe(def.default);
    expect(limitChanges(app.db)).toEqual([]);
  });

  test("changing a limit changes what it governs: pins, a crew member's budget, sign-ins, check concurrency", async () => {
    const { cookie } = await login("alice");
    const names = Array.from({ length: 13 }, (_, i) => `repo${i}`);

    // Pins: thirteen is over twelve until the limit is raised.
    const before = setFront(app, alice, { pinned: names, hidden: [] }, true);
    expect(!before.ok && before.error.kind === "invalid" && before.error.message).toBe("pin at most 12");
    expect((await post(cookie, { key: "front.pinned_max", value: "13" })).status).toBe(303);
    const after = setFront(app, alice, { pinned: names, hidden: [] }, true);
    // Thirteen pins now pass the limit; only the repositories not existing refuses.
    expect(!after.ok && after.error.kind === "invalid" && after.error.message).not.toMatch(/^pin at most/);
    expect(after.ok).toBe(false);

    // A crew member's budget: 150 dollars is over the ceiling of 100 until raised.
    const mk = (username: string, budgetUsd: number) =>
      createAgent(app, alice, { username, budgetUsd });
    expect(await mk("robot-a", 150)).toEqual({ ok: false, error: "invalid_budget" });
    await post(cookie, { key: "agent.budget_max_usd", value: "200" });
    expect((await mk("robot-b", 150)).ok).toBe(true);

    // Sign-ins: with two attempts allowed a minute, the third is turned away.
    await post(cookie, { key: "signin.per_account", value: "2" });
    const bad = [await login("carol", "x"), await login("carol", "x"), await login("carol", "x")];
    expect(bad[0]!.text).not.toContain("Too many attempts");
    expect(bad[2]!.text).toContain("Too many attempts");
    await post(cookie, { key: "signin.per_account", reset: "1" });
    expect(limitValue(app.db, "signin.per_account")).toBe(LIMITS["signin.per_account"].default);

    // Check concurrency is the capacity setting, listed here: one value.
    await post(cookie, { key: "checks.concurrency", value: "4" });
    expect(limitValue(app.db, "checks.concurrency")).toBe(4);
    expect(capacityCount(app.db, "checks.concurrency", 1)).toBe(4);
  });

  test("every change is kept with who made it and when", () => {
    const kept = limitChanges(app.db);
    expect(kept.map((c) => [c.key, c.from, c.to, c.actorName])).toEqual([
      ["checks.concurrency", "1", "4", "alice"],
      ["signin.per_account", "2", "20", "alice"],
      ["signin.per_account", "20", "2", "alice"],
      ["agent.budget_max_usd", "100", "200", "alice"],
      ["front.pinned_max", "12", "13", "alice"],
    ]);
    expect(kept.every((c) => Date.parse(c.at) > 0)).toBe(true);
  });

  test("the API lists and changes limits for an admin only, and refuses out-of-bounds values", async () => {
    const adminToken = createToken(app.db, alice.id, "t", "admin").token;
    const bobToken = createToken(app.db, bob.id, "t", "admin").token;
    const api = (token: string, method: string, path: string, body?: unknown) =>
      fetch(`${servers.url}/api/v1${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const listed = await api(adminToken, "GET", "/admin/limits");
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { limits: unknown[] }).limits).toHaveLength(LIMIT_KEYS.length);
    expect((await api(bobToken, "GET", "/admin/limits")).status).toBe(404);
    expect((await api(bobToken, "PUT", "/admin/limits/share.daily_max", { value: "9" })).status).toBe(404);
    expect((await api(adminToken, "PUT", "/admin/limits/share.daily_max", { value: "0" })).status).toBe(422);
    expect((await api(adminToken, "PUT", "/admin/limits/nothing.here", { value: "3" })).status).toBe(422);
    expect(limitValue(app.db, "share.daily_max")).toBe(LIMITS["share.daily_max"].default);
    const put = await api(adminToken, "PUT", "/admin/limits/share.daily_max", { value: "9" });
    expect(put.status).toBe(200);
    expect(limitValue(app.db, "share.daily_max")).toBe(9);
    expect((await api(adminToken, "PUT", "/admin/limits/share.daily_max", { value: 11 })).status).toBe(200);
    expect(limitValue(app.db, "share.daily_max")).toBe(11);
    expect((await api(adminToken, "PUT", "/admin/limits/share.daily_max", { value: null })).status).toBe(200);
    expect(limitValue(app.db, "share.daily_max")).toBe(LIMITS["share.daily_max"].default);
  });
});
