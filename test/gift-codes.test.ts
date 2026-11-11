/**
 * Gift codes (#11157): an admin makes one, a visitor redeems it and the forge
 * is made on its plan with an entitlement sourced `code:<id>`; one-use,
 * revoked, expired and wrong codes are refused; redemption is rate-limited;
 * every make, redeem and revoke is audited; nothing calls a payment provider.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { entitlementOf, getStored } from "../src/billing/store.ts";
import { hashCode, normalizeCode } from "../src/billing/codes.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { ok } from "../src/kernel/result.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { bootHostedChild } from "../src/spawn/host.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { resetAnonSpawns } from "../src/spawn/rate.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("gift codes", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin = "";
  let adminRo = "";
  let bob = "";
  let n = 0;
  const made: string[] = [];

  const send = (method: string, path: string, token: string | undefined, payload?: unknown, origin = true) =>
    fetch(`${servers.url}${path}`, {
      method,
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? {} : { origin: "https://evil.example" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  const form = (path: string, token: string, fields: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams(fields),
    });
  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: "forges", arguments: args } }),
    });
    const text = await res.text();
    const line = text.startsWith("event") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
    return JSON.parse(line).result;
  };
  const fresh = () => {
    app.db.exec("DELETE FROM gift_try");
    resetAnonSpawns(app.db);
  };
  const make = async (body: Record<string, unknown> = {}) => {
    const res = await send("POST", "/api/v1/codes", admin, { plan: "medium", dryRun: false, ...body });
    expect(res.status).toBe(201);
    return (await res.json()) as { code: string; link: string; made: { id: string } };
  };
  const spawn = (token: string | undefined, name: string, code: unknown, extra: Record<string, unknown> = {}) => {
    made.push(name);
    return send("POST", "/api/v1/forges", token, { name, dryRun: false, code, ...extra });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-gift-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge-code" });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("user");
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    adminRo = createToken(app.db, a.value.id, "ro", "ro").token;
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error("user");
    bob = createToken(app.db, b.value.id, "admin", "admin").token;
    const code = await createRepo(app, a.value, { name: "forge-code", visibility: "public" });
    if (!code.ok) throw new Error("repo");
    await commitToBranch(app, a.value, code.value, { message: "v1", files: [{ path: "src/main.ts", content: "1" }] });
    useProbe(app, () => async () => true);
    usePlacement(app, { place: async (p) => ok({ url: `https://${p.name}.fake.test`, bodyId: `fake-${p.name}` }), retire: async () => ok() });
  }, 30_000);

  afterAll(async () => {
    for (const name of made) await bootHostedChild(app, name);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a code is short, typed easily, and kept only as a hash", async () => {
    const planned = await send("POST", "/api/v1/codes", admin, { plan: "medium" });
    expect(await planned.json()).toMatchObject({ dryRun: true, plan: { plan: "medium", uses: 1, note: "" } });
    expect(app.db.query("SELECT COUNT(*) AS n FROM gift_code").get()).toEqual({ n: 0 });
    const m = await make({ note: "for Mark" });
    expect(m.code).toMatch(/^forge-[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(m.link).toBe(`${servers.url}/?code=${m.code}`);
    const row = app.db.query<{ hash: string }, []>("SELECT * FROM gift_code").get()!;
    expect(row.hash).toBe(hashCode(m.code));
    expect(JSON.stringify(app.db.query("SELECT * FROM gift_code").all())).not.toContain(m.code);
    expect(normalizeCode(`  ${m.code.toUpperCase()} `)).toBe(m.code);
    expect(normalizeCode("forge-xx")).toBeUndefined();
    const list = await (await send("GET", "/api/v1/codes", admin)).text();
    expect(list).not.toContain(m.code);
    expect(list).toContain("for Mark");
  });

  test("make validates, and only a person admin may", async () => {
    expect((await send("POST", "/api/v1/codes", admin, { plan: "free" })).status).toBe(422);
    expect((await send("POST", "/api/v1/codes", admin, { plan: "huge" })).status).toBe(422);
    expect((await send("POST", "/api/v1/codes", admin, { plan: "small", uses: 0 })).status).toBe(422);
    expect((await send("POST", "/api/v1/codes", admin, { plan: "small", note: "x".repeat(81) })).status).toBe(422);
    expect((await send("POST", "/api/v1/codes", admin, { plan: "small", note: "a\nb" })).status).toBe(422);
    expect((await send("POST", "/api/v1/codes", admin, { plan: "small", expires: "2001-01-01" })).status).toBe(422);
    expect((await send("POST", "/api/v1/codes", bob, { plan: "small", dryRun: false })).status).toBe(404);
    expect((await send("POST", "/api/v1/codes", adminRo, { plan: "small", dryRun: false })).status).toBeGreaterThanOrEqual(403);
    expect((await send("POST", "/api/v1/codes", admin, { plan: "small", dryRun: false }, false)).status).toBe(403);
    expect((await send("GET", "/api/v1/codes", bob)).status).toBe(404);
  });

  test("make, redeem: the forge is on that plan, sourced code:<id>, with no payment call", async () => {
    fresh();
    const m = await make({ plan: "medium", note: "for Mark" });
    const seen = await (await send("POST", "/api/v1/forges", bob, { name: "gifted", code: m.code })).json();
    expect(seen).toMatchObject({ dryRun: true, gift: { plan: "medium" } });
    expect(JSON.stringify(seen)).not.toContain("alice");
    expect(app.db.query("SELECT used FROM gift_code WHERE id = ?").get(m.made.id)).toEqual({ used: 0 });
    const real = globalThis.fetch;
    let outside = 0;
    globalThis.fetch = ((input: any, init?: any) => {
      if (!String(input?.url ?? input).startsWith(servers.url)) outside++;
      return real(input, init);
    }) as typeof fetch;
    let res: Response;
    try {
      res = await spawn(bob, "gifted", m.code);
    } finally {
      globalThis.fetch = real;
    }
    expect(res.status).toBe(201);
    expect(outside).toBe(0);
    expect(entitlementOf(app.db, "gifted", "small")).toEqual({ forge: "gifted", plan: "medium", status: "active", source: `code:${m.made.id}` });
    expect(getStored(app.db, "gifted")?.provider).toBe("none");
    const list = (await (await send("GET", "/api/v1/codes", admin)).json()) as any;
    const row = list.codes.find((c: any) => c.id === m.made.id);
    expect(row).toMatchObject({ used: 1, uses: 1, redeemed: [{ forge: "gifted" }] });
    const kinds = app.db.query<{ kind: string }, []>("SELECT kind FROM event WHERE kind LIKE 'billing.code.%'").all().map((e) => e.kind);
    expect(kinds).toContain("billing.code.make");
    expect(kinds).toContain("billing.code.redeem");
  });

  test("a stranger redeems too, and a one-use code is refused the second time", async () => {
    fresh();
    const m = await make({ plan: "large" });
    expect((await spawn(undefined, "stranger-one", m.code)).status).toBe(201);
    expect(entitlementOf(app.db, "stranger-one", "small").plan).toBe("large");
    const again = await spawn(bob, "stranger-two", m.code);
    expect(again.status).toBe(422);
    expect(JSON.stringify(await again.json())).toContain("used as many times");
    expect(getStored(app.db, "stranger-two")).toBeUndefined();
  });

  test("a code with three uses lets three forges through, then says so", async () => {
    fresh();
    const m = await make({ plan: "small", uses: 3 });
    for (const name of ["multi-a", "multi-b", "multi-c"]) expect((await spawn(bob, name, m.code)).status).toBe(201);
    expect((await spawn(bob, "multi-d", m.code)).status).toBe(422);
  });

  test("a forge that fails to be made gives the use back", async () => {
    fresh();
    const m = await make({ plan: "small" });
    expect((await spawn(bob, "Bad Name!", m.code)).status).toBe(422);
    expect(app.db.query("SELECT used FROM gift_code WHERE id = ?").get(m.made.id)).toEqual({ used: 0 });
    expect((await spawn(bob, "after-bad", m.code)).status).toBe(201);
  });

  test("two redeems race for the last use: exactly one forge is made", async () => {
    fresh();
    const m = await make({ plan: "small", uses: 1 });
    const [a, b] = await Promise.all([spawn(bob, "race-a", m.code), spawn(bob, "race-b", m.code)]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    expect(app.db.query("SELECT used FROM gift_code WHERE id = ?").get(m.made.id)).toEqual({ used: 1 });
    expect(app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM gift_redeem WHERE code_id = ?").get(m.made.id)!.n).toBe(1);
  });

  test("a forge whose making throws gives the use back, and the code works again", async () => {
    fresh();
    const m = await make({ plan: "small" });
    usePlacement(app, { place: async () => { throw new Error("placement crashed"); }, retire: async () => ok() });
    const crashed = await spawn(bob, "throws-once", m.code).catch(() => undefined);
    expect(crashed === undefined || crashed.status >= 400).toBe(true);
    expect(app.db.query("SELECT used FROM gift_code WHERE id = ?").get(m.made.id)).toEqual({ used: 0 });
    usePlacement(app, { place: async (p) => ok({ url: `https://${p.name}.fake.test`, bodyId: `fake-${p.name}` }), retire: async () => ok() });
    expect((await spawn(bob, "after-throw", m.code)).status).toBe(201);
  });

  test("revoked and expired codes are refused; forges already made keep their plan", async () => {
    fresh();
    const r = await make({ plan: "large", uses: 5 });
    expect((await spawn(bob, "keeps-plan", r.code)).status).toBe(201);
    expect((await send("DELETE", `/api/v1/codes/${r.made.id}`, bob)).status).toBe(404);
    expect((await send("DELETE", `/api/v1/codes/${r.made.id}`, admin)).status).toBe(200);
    expect((await send("DELETE", `/api/v1/codes/${r.made.id}`, admin)).status).toBe(404);
    const refused = await spawn(bob, "after-revoke", r.code);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toContain("cancelled");
    expect(entitlementOf(app.db, "keeps-plan", "small").plan).toBe("large");

    const e = await make({ plan: "small", expires: new Date(Date.now() + 86_400_000 * 3).toISOString().slice(0, 10) });
    app.db.query("UPDATE gift_code SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(e.made.id);
    const gone = await spawn(bob, "after-expiry", e.code);
    expect(gone.status).toBe(422);
    expect(JSON.stringify(await gone.json())).toContain("expired");
    expect((await spawn(bob, "after-wrong", "forge-aaaa-bbbb")).status).toBe(422);
    const kinds = app.db.query<{ kind: string }, []>("SELECT kind FROM event WHERE kind = 'billing.code.revoke'").all();
    expect(kinds.length).toBe(1);
  });

  test("redemption is rate-limited per client, so codes cannot be guessed by trying", async () => {
    fresh();
    const seen: number[] = [];
    for (let i = 0; i < 12; i++) seen.push((await send("POST", "/api/v1/forges", bob, { name: "guess", code: `forge-aaaa-${i.toString().padStart(4, "b")}` })).status);
    expect(seen.slice(0, 10).every((x) => x === 422)).toBe(true);
    expect(seen[10]).toBe(429);
    expect(seen[11]).toBe(429);
    fresh();
  });

  test("a code and a plan together are refused: the code names its own", async () => {
    fresh();
    const m = await make({ plan: "small" });
    expect((await send("POST", "/api/v1/forges", bob, { name: "both", code: m.code, plan: "large" })).status).toBe(422);
  });

  test("MCP forges plans a code first, then makes and revokes it with dryRun false", async () => {
    fresh();
    const plan = await mcp(admin, { code: { plan: "small", note: "mcp" } });
    expect(JSON.stringify(plan)).toContain("nothing was made");
    expect(app.db.query("SELECT COUNT(*) AS n FROM gift_code WHERE note = 'mcp'").get()).toEqual({ n: 0 });
    const live = await mcp(admin, { code: { plan: "small", note: "mcp" }, dryRun: false });
    expect(JSON.stringify(live)).toContain("/?code=forge-");
    const id = app.db.query<{ id: string }, []>("SELECT id FROM gift_code WHERE note = 'mcp'").get()!.id;
    expect(JSON.stringify(await mcp(admin, { codes: true }))).toContain("mcp");
    await mcp(admin, { revoke: id });
    expect(app.db.query("SELECT revoked_at FROM gift_code WHERE id = ?").get(id)).toEqual({ revoked_at: null });
    await mcp(admin, { revoke: id, dryRun: false });
    expect(app.db.query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM gift_code WHERE id = ?").get(id)!.revoked_at).not.toBeNull();
    await mcp(bob, { code: { plan: "small" }, dryRun: false });
    expect(JSON.stringify(await mcp(bob, { code: { plan: "small" }, dryRun: false }))).not.toContain("/?code=");
  });

  test("the Billing page makes a code once, lists it first, and revokes it; the link fills the form", async () => {
    fresh();
    const page = await (await send("GET", "/settings/billing", admin)).text();
    expect(page.indexOf("<h2>Plans</h2>")).toBeGreaterThan(0);
    expect(page.indexOf("<h2>Plans</h2>")).toBeLessThan(page.indexOf('id="codes"'));
    const res = await form("/settings/billing/codes", admin, { plan: "medium", uses: "2", note: "for <Mark>", expires: "" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const code = /forge-[a-z0-9]{4}-[a-z0-9]{4}/.exec(text)![0];
    expect(text).toContain(`/?code=${code}`);
    expect(text).toContain("for &lt;Mark&gt;");
    expect(text).toContain("Stop this code working");
    expect(await (await send("GET", "/settings/billing", admin)).text()).not.toContain(code);
    expect((await form("/settings/billing/codes", admin, { plan: "free", uses: "1" })).status).toBe(422);
    expect((await form("/settings/billing/codes", bob, { plan: "small" })).status).toBe(404);

    const home = await send("GET", `/?code=${code}`, undefined);
    expect(home.status).toBe(303);
    expect(home.headers.get("location")).toBe("/forges/new");
    const jar = home.headers.get("set-cookie")!;
    expect(jar).toContain("HttpOnly");
    const cookie = jar.split(";")[0]!;
    const seeNew = (c?: string) => fetch(`${servers.url}/forges/new`, { redirect: "manual", headers: c ? { cookie: c } : {} });
    // The same code in the new-forge address also leaves the address.
    const moved = await send("GET", `/forges/new?code=${code}`, undefined);
    expect(moved.status).toBe(303);
    expect(moved.headers.get("location")).toBe("/forges/new");
    const gift = await (await seeNew(cookie)).text();
    expect(gift).toContain("A gift: a medium forge, free.");
    expect(gift).not.toContain("alice:");
    expect(gift).toContain(`value="${code}"`);
    expect(gift).not.toContain("Have a code?");
    const bare = await (await seeNew()).text();
    expect(bare).toContain("Have a code?");
    expect(bare).not.toContain("A gift:");
    const wrongText = await (await seeNew("forge_gift=forge-zzzz-zzzz")).text();
    expect(wrongText).toContain("That code is not one this forge knows");
    expect(wrongText).toContain('id="new-forge"');

    const id = app.db.query<{ id: string }, [string]>("SELECT id FROM gift_code WHERE hash = ?").get(hashCode(code))!.id;
    const rev = await form("/settings/billing/codes/revoke", admin, { id });
    expect(rev.status).toBe(303);
    expect(await (await seeNew(cookie)).text()).toContain("cancelled");
  });

  test("ten codes fit the first view: one line each", async () => {
    fresh();
    for (let i = 0; i < 10; i++) await make({ plan: "small", note: `n${i}` });
    const text = await (await send("GET", "/settings/billing", admin)).text();
    const section = text.slice(text.indexOf('id="codes"'));
    expect(section.match(/data-code="/g)!.length).toBeGreaterThanOrEqual(10);
    expect(section.match(/<form/g)!.length).toBeLessThanOrEqual(section.match(/data-code="/g)!.length + 1);
  });
});
