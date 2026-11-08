/** Settings → Flags (#1970): admin-only, validated, live at once, kept. */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { checkInput, makeFlags, winnerOffer } from "../src/core/flags.ts";
import { createRepo } from "../src/core/repos.ts";
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
        origin: "seed",
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
    expect(text).toContain('class="row-fields"');
    expect(text).not.toContain("flag-form");

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

  test("each flag's form is §5d's row-fields, posting its own name and fields (#4891)", async () => {
    const cookie = await login("alice");
    const text = await (await fetch(`${servers.url}/settings/flags`, { headers: { cookie } })).text();
    expect(text).not.toContain("flag-form");
    const forms = text.match(/<form class="row-fields" method="post" action="\/settings\/flags">[\s\S]*?<\/form>/g) ?? [];
    expect(forms.length).toBe(Object.keys(reg.decls).length);
    const form = forms[0]!;
    expect(form).toContain('<input type="hidden" name="name" value="alpha" />');
    for (const field of ['name="forge"', 'name="users"', 'name="roles"', 'name="percent"', 'name="clear"'])
      expect(form).toContain(field);

    expect((await post(cookie, { name: "alpha", forge: "off", percent: "5" })).status).toBe(303);
    expect(reg.value("alpha")).toEqual({ forge: false, percent: 5 });
    await post(cookie, { name: "alpha", clear: "1" });
    expect(reg.value("alpha")).toBeUndefined();
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

describe("flag read-out (#1829)", () => {
  test("counts per variant match the table, for 7 and 30 days", () => {
    const r = makeFlags({ alpha: decl });
    const db = new Database(":memory:");
    db.exec("CREATE TABLE flag_use (day TEXT NOT NULL, flag TEXT NOT NULL, variant INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, flag, variant)) WITHOUT ROWID");
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    const put = db.query("INSERT INTO flag_use VALUES (?1, 'alpha', ?2, ?3)");
    put.run(day(10), 1, 100);
    put.run(day(40), 0, 900);
    put.run(day(2), 0, 5);
    expect(r.uses(db, "alpha", 7)).toEqual({ on: 0, off: 5 });
    for (let i = 0; i < 3; i++) r.flag("alpha");
    expect(r.uses(db, "alpha", 7)).toEqual({ on: 0, off: 8 });
    expect(r.uses(db, "alpha", 30)).toEqual({ on: 100, off: 8 });
    expect(db.query("SELECT SUM(n) AS n FROM flag_use WHERE flag = 'alpha' AND day >= ?1").get(day(29))).toEqual({ n: 108 });
    expect(r.uses(db, "beta", 30)).toEqual({ on: 0, off: 0 });
  });

  test("a read runs no query; flush writes the batch", () => {
    const r = makeFlags({ alpha: decl });
    const db = new Database(":memory:"); // no table: a query would throw
    for (let i = 0; i < 4; i++) expect(r.flag("alpha")).toBe(false);
    r.flush(db); // fails quietly, keeps the counts
    db.exec("CREATE TABLE flag_use (day TEXT NOT NULL, flag TEXT NOT NULL, variant INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, flag, variant)) WITHOUT ROWID");
    expect(r.uses(db, "alpha", 7)).toEqual({ on: 0, off: 4 });
  });
});

describe("make the winner the default (#1829)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  const reg2 = makeFlags({ beta: decl });
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flagwin-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    useFlagRegistry(reg2);
  });
  afterAll(async () => {
    useFlagRegistry(undefined);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("opens the removal issue and the flag reads the winner", async () => {
    const res0 = await fetch(`${servers.url}/signin`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (res0.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    for (let i = 0; i < 60; i++) reg2.flag("beta"); // off x60: enough reads to call a winner
    const post = (body: Record<string, string>) =>
      fetch(`${servers.url}/settings/flags`, {
        method: "POST", redirect: "manual",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
        body: new URLSearchParams(body),
      });
    reg2.set(app.db, "beta", { users: ["u1"] }, "x");
    const page = await (await fetch(`${servers.url}/settings/flags`, { headers: { cookie } })).text();
    expect(page).toContain("Uses, 7 days");
    expect(page).toContain("Uses, 7 days: on 0 · off 60");
    expect(page).toContain("Make off the default");
    expect(winnerOffer({ on: 3, off: 2 }, undefined)).toBeUndefined(); // too few reads
    expect(winnerOffer({ on: 5, off: 60 }, { forge: false })).toBeUndefined(); // already the value
    expect(winnerOffer({ on: 30, off: 30 }, undefined)).toBeUndefined(); // a tie
    expect(winnerOffer({ on: 5, off: 60 }, { forge: true })).toBe("off");

    // The unoffered variant (and a flag with too few reads) is refused: no issue, no change.
    expect((await post({ name: "beta", winner: "on" })).status).toBe(303);
    expect(reg2.value("beta")).toEqual({ users: ["u1"] });
    expect(app.db.query("SELECT 1 FROM issue").all()).toEqual([]);

    expect((await post({ name: "beta", winner: "off" })).status).toBe(303);
    expect(reg2.value("beta")).toEqual({ forge: false });
    expect(reg2.flag("beta")).toBe(false);
    const issues = app.db.query<{ title: string; body: string }, []>("SELECT title, body FROM issue").all();
    expect(issues.length).toBe(1);
    expect(issues[0]!.title).toContain("Remove flag beta");
    expect(issues[0]!.body).toContain("#1970");
    expect(issues[0]!.title).toContain("keep the off path");

    await post({ name: "nope", winner: "on" });
    expect(app.db.query("SELECT 1 FROM issue").all().length).toBe(1);
  });
});
