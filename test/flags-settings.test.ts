/** Settings → Flags (#1970): admin-only, validated, live at once, kept. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { checkInput, makeFlags } from "../src/core/flags.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { useFlagRegistry } from "../src/web/pages/flags.ts";

const decl = { why: "shows the new board", default: false, issue: 1970 };
const reg = makeFlags({ alpha: decl });

describe("settings → flags", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceId = "";

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const post = (cookie: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}/settings/flags`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flags-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "acme/forge" });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const u = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      if (username === "alice") aliceId = u.value.id;
    }
    useFlagRegistry(reg);
  });
  afterAll(async () => {
    useFlagRegistry(undefined);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a non-admin gets 403 on the page and the POST, and nothing changes", async () => {
    const bob = await login("bob");
    expect((await fetch(`${servers.url}/settings/flags`, { headers: { cookie: bob } })).status).toBe(403);
    expect((await post(bob, { name: "alpha", forge: "on" })).status).toBe(403);
    expect(reg.flag("alpha")).toBe(false);
  });

  test("an admin sees the declared flag, sets it live, and clears it", async () => {
    const cookie = await login("alice");
    const text = await (await fetch(`${servers.url}/settings/flags`, { headers: { cookie } })).text();
    expect(text).toContain("alpha");
    expect(text).toContain("shows the new board");
    expect(text).toContain('href="/acme/forge/issues/1970"');

    const set = await post(cookie, { name: "alpha", forge: "on", users: "u1, u2", roles: "admin", percent: "30" });
    expect(set.status).toBe(303);
    expect(reg.value("alpha")).toEqual({ forge: true, users: ["u1", "u2"], roles: ["admin"], percent: 30 });
    expect(reg.flag("alpha")).toBe(true);
    const log = app.db.query("SELECT actor_id FROM forge_setting_change WHERE key = 'flag.alpha'").all();
    expect(log).toEqual([{ actor_id: aliceId }]);

    await post(cookie, { name: "alpha", clear: "1" });
    expect(reg.value("alpha")).toBeUndefined();
    expect(reg.flag("alpha")).toBe(false);
  });

  test("a bad value, an unknown flag and a foreign origin change nothing", async () => {
    const cookie = await login("alice");
    await post(cookie, { name: "alpha", percent: "101" });
    await post(cookie, { name: "alpha", users: "a;drop" });
    await post(cookie, { name: "nope", forge: "on" });
    expect((await post(cookie, { name: "alpha", forge: "on" }, "https://evil.example")).status).toBeGreaterThanOrEqual(400);
    expect(reg.value("alpha")).toBeUndefined();
    expect(app.db.query("SELECT key FROM forge_setting WHERE key LIKE 'flag.%'").all()).toEqual([]);
  });
});

describe("checkInput", () => {
  const base = { forge: "", users: "", roles: "", percent: "" };
  test("validates against the declared shape", () => {
    expect(checkInput(base)).toEqual({ ok: true, value: undefined });
    expect(checkInput({ ...base, forge: "off", percent: "0" })).toEqual({ ok: true, value: { forge: false, percent: 0 } });
    for (const bad of [{ forge: "maybe" }, { percent: "-1" }, { percent: "1.5" }, { percent: "101" }, { users: "a b/c" }, { roles: "Admin" }])
      expect(checkInput({ ...base, ...bad }).ok).toBe(false);
  });
});
