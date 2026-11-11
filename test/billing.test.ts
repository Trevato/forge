/**
 * What each forge is entitled to (#11134): the entitlement store, an admin's hand
 * grant through the API, the page and the MCP, its audit trail, and the spawn
 * path a visitor takes, unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { changesOf, entitlementOf, getStored, putEntitlement } from "../src/billing/store.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { ok } from "../src/kernel/result.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { bootHostedChild } from "../src/spawn/host.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("billing seam", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin = "";
  let adminRo = "";
  let bob = "";
  let n = 0;

  const send = (method: string, path: string, token: string | undefined, payload?: unknown, origin = true) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? {} : { origin: "https://evil.example" }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-billing-"));
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
    await bootHostedChild(app, "kid");
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the store keeps one row per forge and every change", () => {
    expect(entitlementOf(app.db, "x", "medium")).toEqual({ forge: "x", plan: "medium", status: "active", source: "granted" });
    expect(getStored(app.db, "x")).toBeUndefined();
    putEntitlement(app.db, { forge: "x", plan: "large", status: "grace", periodEnd: 5, source: "granted" }, "medium", "u1");
    putEntitlement(app.db, { forge: "x", plan: "small", status: "active", source: "granted", payer: "p@x.y" }, "medium", "u1");
    expect(app.db.query("SELECT COUNT(*) AS n FROM entitlement WHERE forge = 'x'").get()).toEqual({ n: 1 });
    expect(getStored(app.db, "x")).toMatchObject({ plan: "small", payer: "p@x.y", provider: "none" });
    const c = changesOf(app.db, "x");
    expect(c.map((r) => [r.fromPlan, r.toPlan, r.toStatus])).toEqual([["large", "small", "active"], ["medium", "large", "grace"]]);
  });

  test("a status outside active, grace and none is refused by the table", () => {
    expect(() => app.db.query("INSERT INTO entitlement (forge, plan, status, source, updated_at) VALUES ('bad','small','paid','x','')").run()).toThrow();
  });

  test("a visitor's spawn is unchanged: no row is written and the forge reads active on its size", async () => {
    const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entitlement").get()!.n;
    const res = await send("POST", "/api/v1/forges", undefined, { name: "kid", dryRun: false });
    expect(res.status).toBe(201);
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM entitlement").get()!.n).toBe(before);
    const plan = (await (await send("GET", "/api/v1/forges/kid/plan", admin)).json()) as any;
    expect(plan.entitlement).toEqual({ forge: "kid", plan: "small", status: "active", source: "granted" });
  });

  test("an admin grant changes the plan and the audit trail shows it", async () => {
    const res = await send("PUT", "/api/v1/forges/kid/plan", admin, { plan: "large" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.entitlement).toEqual({ forge: "kid", plan: "large", status: "active", source: "granted" });
    expect(body.changes[0]).toMatchObject({ fromPlan: "small", toPlan: "large", source: "granted" });
    const ev = app.db.query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'billing.plan'").all();
    expect(ev.map((e) => JSON.parse(e.payload))).toEqual([{ forge: "kid", from: "small", to: "large", source: "granted" }]);
  });

  test("the grant is validated and guarded", async () => {
    expect((await send("PUT", "/api/v1/forges/kid/plan", admin, { plan: "huge" })).status).toBe(422);
    expect((await send("PUT", "/api/v1/forges/kid/plan", admin, {})).status).toBe(422);
    expect((await send("PUT", "/api/v1/forges/nope/plan", admin, { plan: "small" })).status).toBe(404);
    expect((await send("PUT", "/api/v1/forges/kid/plan", bob, { plan: "small" })).status).toBe(404);
    expect((await send("PUT", "/api/v1/forges/kid/plan", undefined, { plan: "small" })).status).toBeGreaterThanOrEqual(401);
    expect((await send("PUT", "/api/v1/forges/kid/plan", adminRo, { plan: "small" })).status).toBeGreaterThanOrEqual(403);
    expect((await send("PUT", "/api/v1/forges/kid/plan", admin, { plan: "small" }, false)).status).toBe(403);
    expect(entitlementOf(app.db, "kid", "small").plan).toBe("large");
  });

  test("MCP forges plans first, then grants with dryRun false", async () => {
    const plan = await mcp(admin, { forge: "kid", plan: "medium" });
    expect(JSON.stringify(plan)).toContain("nothing changed");
    expect(entitlementOf(app.db, "kid", "small").plan).toBe("large");
    await mcp(admin, { forge: "kid", plan: "medium", dryRun: false });
    expect(entitlementOf(app.db, "kid", "small").plan).toBe("medium");
    const read = await mcp(admin, { forge: "kid" });
    expect(JSON.stringify(read)).toContain("medium");
    expect(JSON.stringify(await mcp(bob, { forge: "kid", plan: "small", dryRun: false }))).not.toContain("granted");
    expect(entitlementOf(app.db, "kid", "small").plan).toBe("medium");
  });

  test("the Billing page lists forges and grants; only an admin sees it", async () => {
    const page = await send("GET", "/settings/billing", admin);
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Choose the plan each forge is on.");
    expect(text).toContain("Paste a Stripe secret or restricted key");
    expect(text).toContain('data-forge="kid"');
    expect((await send("GET", "/settings/billing", bob)).status).toBe(404);
  });

  test("the Billing page says the last Stripe event and the refused signatures, or that none came", async () => {
    const before = await (await send("GET", "/settings/billing", admin)).text();
    expect(before).toContain("No event yet");
    expect(before).toContain("<dt>Refused today</dt><dd>0</dd>");
    const now = new Date().toISOString();
    app.db.query("INSERT INTO stripe_event (id, type, at) VALUES ('evt_page', 'invoice.paid', ?1)").run(now);
    app.db.query("INSERT INTO stripe_hook_refused (day, kind, n) VALUES (?1, 'bad', 1)").run(now.slice(0, 10));
    const after = await (await send("GET", "/settings/billing", admin)).text();
    expect(after).toContain("invoice.paid");
    expect(after).toContain(now.slice(0, 16).replace("T", " "));
    expect(after).toContain("<dt>Refused today</dt><dd>1</dd>");
    expect(after).not.toContain("No event yet");
    expect(after).toContain("<dt>Refused today</dt>");
  });

  test("a non-admin gets 404 and no event data on the Billing page", async () => {
    const res = await send("GET", "/settings/billing", bob);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("invoice.paid");
    expect(text).not.toContain("Refused today");
  });
});
