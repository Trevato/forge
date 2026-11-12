/**
 * Plans are a setting (#11135): free, small, medium and large, each with a
 * size, a monthly price, a monthly crew credit and a forge count. An admin's
 * edit changes what GET /api/v1/plans answers and what the next spawn gets,
 * with no restart; a spawn on each plan takes its size and credit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { hostedPlacement, memoryBodies } from "../src/spawn/placement.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { addSpend, periodOf, readCredit } from "../src/spawn/credit.ts";
import { DEFAULT_PLANS, getPlans, parsePlans } from "../src/settings/plans.ts";
import { planRefusal } from "../src/spawn/sleep.ts";
import { grantPlanCredit } from "../src/actions/spawn.ts";
import { setLimit } from "../src/settings/limits.ts";

const PASSWORD = "a-long-new-forge-passphrase";

describe("plans", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let bob = "";
  let admin = "";
  let adminId = "";
  const url = (p: string) => `${servers.url}${p}`;
  const plans = async () => ((await (await fetch(url("/api/v1/plans"))).json()) as { items: any[] }).items;
  const spawn = (tok: string | undefined, name: string, plan?: string, extra: Record<string, unknown> = {}) =>
    fetch(url("/api/v1/forges"), {
      method: "POST",
      headers: { "content-type": "application/json", ...(tok === undefined ? { origin: "https://forge.test" } : { authorization: `Bearer ${tok}` }) },
      body: JSON.stringify({ name, apps: [], dryRun: false, ...(plan === undefined ? {} : { plan }), ...extra }),
    });
  const put = (tok: string, list: unknown) =>
    fetch(url("/api/v1/admin/plans"), {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
      body: JSON.stringify({ plans: list }),
    });
  const ledger = async (name: string) => JSON.parse(await readFile(join(dir, "spawn", `${name}.json`), "utf8")) as { size: string; plan?: string };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-plans-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: PASSWORD, isAdmin: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@x.test", password: PASSWORD });
    if (!a.ok || !b.ok) throw new Error("users");
    adminId = a.value.id;
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    bob = createToken(app.db, b.value.id, "rw", "rw").token;
    usePlacement(app, hostedPlacement({ host: "https://forge.test", store: memoryBodies(), maxChildren: 50 }));
    useProbe(app, () => ({ live: async () => true }) as never);
    servers = await serve(app);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the defaults: free, small, medium and large, public and without secrets", async () => {
    const items = await plans();
    expect(items.map((p) => [p.key, p.size, p.priceUsd, p.creditUsd])).toEqual([
      ["free", "small", 0, 0],
      ["small", "small", 19, 5],
      ["medium", "medium", 49, 15],
      ["large", "large", 149, 50],
    ]);
    for (const p of items) expect(Object.keys(p).sort()).toEqual(["creditUsd", "forges", "key", "name", "priceUsd", "says", "size"]);
    expect(getPlans(app.db)).toEqual([...DEFAULT_PLANS]);
  });

  test("only a person admin edits them; a bad list is refused in a sentence", async () => {
    expect([403, 404]).toContain((await put(bob, DEFAULT_PLANS)).status);
    const noFree = await put(admin, DEFAULT_PLANS.filter((p) => p.key !== "free"));
    expect(noFree.status).toBe(422);
    expect(((await noFree.json()) as any).message).toBe("the free plan cannot be removed");
    const dear = await put(admin, DEFAULT_PLANS.map((p) => (p.key === "free" ? { ...p, priceUsd: 1 } : p)));
    expect(((await dear.json()) as any).message).toBe("the free plan costs $0");
    expect(parsePlans([{ ...DEFAULT_PLANS[0], size: "huge" }]).ok).toBe(false);
    expect(parsePlans([{ ...DEFAULT_PLANS[0], creditUsd: 1.234 }]).ok).toBe(false);
    expect((await plans())[1].priceUsd).toBe(19);
  });

  test("a spawn on each plan takes its size and its credit", async () => {
    for (const [plan, size, credit] of [["free", "small", undefined], ["small", "small", 5], ["medium", "medium", 15], ["large", "large", 50]] as const) {
      const name = `kid-${plan}`;
      const res = await spawn(plan === "free" ? bob : admin, name, plan);
      expect(res.status).toBe(201);
      const l = await ledger(name);
      expect([l.size, l.plan]).toEqual([size, plan]);
      expect(readCredit(app, name)?.capUsd).toBe(credit);
    }
    // A plan and a size that disagree are refused.
    const clash = await spawn(admin, "kid-clash", "medium", { size: "small" });
    expect(clash.status).toBe(422);
    expect((await spawn(admin, "kid-nope", "gold")).status).toBe(422);
  });

  test("an edit changes the answer and the next spawn, with no restart", async () => {
    const edited = DEFAULT_PLANS.map((p) => (p.key === "medium" ? { ...p, priceUsd: 59.5, creditUsd: 20 } : p));
    const res = await put(admin, edited);
    expect(res.status).toBe(200);
    const medium = (await plans()).find((p) => p.key === "medium");
    expect([medium.priceUsd, medium.creditUsd]).toEqual([59.5, 20]);
    expect((await spawn(admin, "kid-medium-2", "medium")).status).toBe(201);
    expect(readCredit(app, "kid-medium-2")?.capUsd).toBe(20);
    // An edit is kept: who, when, from what to what.
    const kept = app.db.query("SELECT actor_id FROM forge_setting_change WHERE key = 'plans'").all() as { actor_id: string }[];
    expect(kept.map((r) => r.actor_id)).toEqual([adminId]);
  });

  test("a paid plan is held to its own count, never the free one; the free plan keeps the free limit", async () => {
    setLimit(app.db, "forges.per_person", 1, adminId);
    // bob holds a free forge: the free plan is full; the admin holds paid ones and a plan with room is not.
    expect((await spawn(bob, "kid-free-2", "free")).status).toBe(409);
    expect((await spawn(admin, "kid-small-2", "small")).status).toBe(201);
    const tight = DEFAULT_PLANS.map((p) => (p.key === "large" ? { ...p, forges: 1 } : p));
    expect((await put(admin, tight)).status).toBe(200);
    // A forge admin is never held to a count; the same person as a plain one is, by the plan's own.
    expect((await spawn(admin, "kid-large-2", "large")).status).toBe(201);
    const plain = planRefusal(dir, { id: adminId, isAdmin: false }, { key: "large", name: "Large", forges: 1 }, "free");
    expect(plain).toBe("you already have 2 forges on the Large plan, the most one person may have (1); remove one first");
    expect(planRefusal(dir, { id: adminId, isAdmin: true }, { key: "large", name: "Large", forges: 1 }, "free")).toBeUndefined();
  });

  test("a plain signed-in person is refused a paid plan, and no credit is lent", async () => {
    for (const plan of ["small", "medium", "large"]) {
      const res = await spawn(bob, `bob-${plan}`, plan);
      expect(res.status).toBe(422);
      expect(((await res.json()) as any).message).toContain("only a forge admin may take it");
      expect(readCredit(app, `bob-${plan}`)).toBeUndefined();
    }
    // The plan alone is refused too, before anything is made.
    expect((await spawn(bob, "bob-dry", "small", { dryRun: true })).status).toBe(422);
  });

  test("a failed credit hand-off lends nothing and says nothing was set", () => {
    const seen: string[] = [];
    const off = app.bus.subscribe((e) => seen.push(e.kind));
    grantPlanCredit(app, { name: "kid-lost", plan: "small" } as never, "no-such-body");
    expect(readCredit(app, "kid-lost")).toBeUndefined();
    expect(seen).not.toContain("forge.credit_set");
    off();
  });

  test("a stranger may take the free plan, never a paid one", async () => {
    const paid = await spawn(undefined, "stranger-paid", "small");
    expect(paid.status).toBe(422);
  });

  test("a plan's credit starts again each calendar month", async () => {
    const now = new Date();
    const spendStart = readCredit(app, "kid-small")!;
    expect(spendStart.period).toBe(periodOf(now));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
    expect(readCredit(app, "kid-small", next)?.period).toBe(periodOf(next));
    // Spend counted this month is gone next month; a cap that never resets keeps its spend.
    addSpend(app, "kid-small", 2);
    expect(readCredit(app, "kid-small")?.spentUsd).toBe(2);
    expect(readCredit(app, "kid-small", next)?.spentUsd).toBe(0);
  });

  test("the plans card is on the limits page and its form saves", async () => {
    const signin = await fetch(url("/signin"), { method: "POST", body: new URLSearchParams({ username: "alice", password: PASSWORD }), redirect: "manual" });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(url("/admin/limits"), { headers: { cookie } })).text();
    expect(page).toContain('name="small.creditUsd"');
    expect(page).toContain('name="small.size"');
    const bad = await fetch(url("/admin/plans"), { method: "POST", headers: { cookie, origin: "https://forge.test" }, body: new URLSearchParams({ "small.creditUsd": "lots" }), redirect: "manual" });
    expect(bad.status).toBe(303);
    expect((await plans()).find((p) => p.key === "small").creditUsd).toBe(5);
    const flash = (bad.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const flashed = await (await fetch(url("/admin/limits"), { headers: { cookie: `${cookie}; ${flash}` } })).text();
    expect(flashed).toContain("small: creditUsd is dollars");
    const form = new URLSearchParams({ "small.priceUsd": "21", "small.creditUsd": "6" });
    const saved = await fetch(url("/admin/plans"), { method: "POST", headers: { cookie, origin: "https://forge.test" }, body: form, redirect: "manual" });
    expect(saved.status).toBe(303);
    const small = (await plans()).find((p) => p.key === "small");
    expect([small.priceUsd, small.creditUsd]).toEqual([21, 6]);
  });

  test("a person who is not an admin cannot POST /admin/plans", async () => {
    const signin = await fetch(url("/signin"), { method: "POST", body: new URLSearchParams({ username: "bob", password: PASSWORD }), redirect: "manual" });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await fetch(url("/admin/plans"), { method: "POST", headers: { cookie, origin: "https://forge.test" }, body: new URLSearchParams({ "small.priceUsd": "1" }), redirect: "manual" });
    expect([403, 404]).toContain(res.status);
    expect((await plans()).find((p) => p.key === "small").priceUsd).toBe(21);
  });

  test("the MCP spawn tool takes a plan: an admin's is made with its size and credit, a plain person's is refused", async () => {
    const mcp = async (tok: string, args: Record<string, unknown>) => {
      const res = await fetch(url("/mcp"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spawn", arguments: args } }),
      });
      const body = (await res.json()) as any;
      return { text: (body.error?.message ?? body.result.content[0].text) as string, error: body.error !== undefined || body.result.isError === true };
    };
    const planned = await mcp(admin, { name: "mcp-kid", plan: "large", dryRun: false });
    expect(planned.error).toBe(false);
    expect([(await ledger("mcp-kid")).size, (await ledger("mcp-kid")).plan]).toEqual(["large", "large"]);
    const refused = await mcp(bob, { name: "mcp-bob", plan: "large", dryRun: false });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("only a forge admin may take it");
  });
});
