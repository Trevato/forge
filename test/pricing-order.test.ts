/** /pricing (#11138): order -> paid -> spawned -> claim link; duplicate delivery makes one forge; a failed spawn raises the alarm. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { placeOrder, reconcileOrder, resendLink, retryOrder, settleSession } from "../src/actions/order.ts";
import { useCheckout, type CheckoutProvider } from "../src/billing/checkout.ts";
import { bindCheckout } from "../src/billing/checkout_completed.ts";
import { CHECKOUT_MS, getOrder, HOLD_MS, MAX_PENDING_PER_ADDRESS } from "../src/billing/orders.ts";
import { getStored } from "../src/billing/store.ts";
import { createUser } from "../src/core/users.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { alarmPaidOrder } from "../src/flow/alarm_paid_order.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ok } from "../src/kernel/result.ts";
import { bootHostedChild } from "../src/spawn/host.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";

let dir: string;
let app: App;
let servers: Servers;
let base: string;
let admin: { id: string } & Record<string, any>;
let full = false;
let placed = 0;
const paidSessions = new Set<string>();
const made: string[] = [];

const fake: CheckoutProvider = {
  name: "fake",
  async create(req) {
    const id = `cs_fake_${req.orderId.slice(4, 16)}`;
    return ok({ id, url: `https://pay.fake.test/${id}` });
  },
  async state(id) {
    return ok({ paid: paidSessions.has(id), customer: "cus_1", subscription: "sub_1" });
  },
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-pricing-"));
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/forge-code" });
  servers = await serve(app);
  base = servers.url;
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("user");
  admin = a.value as any;
  const code = await createRepo(app, a.value, { name: "forge-code", visibility: "public" });
  if (!code.ok) throw new Error("code repo");
  await commitToBranch(app, a.value, code.value, { message: "v1", files: [{ path: "src/main.ts", content: "console.log('forge')" }] });
  useProbe(app, () => async () => true);
  usePlacement(app, {
    place: async (plan) => (full ? { ok: false, error: { kind: "refused", reason: "capacity", message: "no room" } } as any : ok({ url: `https://${plan.name}.fake.test`, bodyId: `fake-${++placed}` })),
    retire: async () => ok(),
  });
  useCheckout(app, fake);
}, 30_000);

afterAll(async () => {
  for (const n of made) await bootHostedChild(app, n);
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const form = (o: Record<string, string>) => ({ method: "POST", redirect: "manual" as const, headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams(o).toString() });
async function buy(name: string, plan = "small") {
  const res = await fetch(`${base}/pricing/order`, form({ name, plan, email: "Buyer@Example.com" }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const order = app.db.query<{ id: string; session_id: string }, [string]>("SELECT id, session_id FROM forge_order WHERE name = ?1 ORDER BY created_at DESC").get(name);
  return { res, cookie, order };
}
const completed = (o: { id: string; session_id: string }) => ({ id: o.session_id, metadata: { order: o.id }, customer: "cus_1", subscription: "sub_1", payment_status: "paid" });

describe("/pricing", () => {
  test("shows the plans with sizes and prices to a stranger, and a way to the free path", async () => {
    const res = await fetch(`${base}/pricing`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("$19 a month");
    expect(text).toContain("Start free");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });

  test("the free plan goes to /forges/new", async () => {
    const res = await fetch(`${base}/pricing/order`, form({ name: "gratis", plan: "free", email: "" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/forges/new");
  });

  test("a bad name, a bad email and a cross-origin post are refused; nothing is held", async () => {
    expect((await fetch(`${base}/pricing/order`, form({ name: "Bad Name", plan: "small", email: "b@x.io" }))).status).toBe(422);
    expect((await fetch(`${base}/pricing/order`, form({ name: "fine", plan: "small", email: "nope" }))).status).toBe(422);
    const evil = form({ name: "fine", plan: "small", email: "b@x.io" });
    evil.headers.origin = "https://evil.test";
    expect((await fetch(`${base}/pricing/order`, evil)).status).toBeGreaterThanOrEqual(400);
    expect(app.db.query("SELECT 1 FROM forge_order").all()).toEqual([]);
  });

  test("order -> webhook paid -> spawned -> the claim link once; a duplicate delivery makes one forge", async () => {
    const { res, cookie, order } = await buy("shop");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toStartWith("https://pay.fake.test/");
    expect(cookie).toStartWith("forge_order=");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(getOrder(app.db, order!.id)?.state).toBe("pending");
    // The name is held for someone else.
    const other = await fetch(`${base}/pricing/order`, form({ name: "shop", plan: "small", email: "z@x.io" }));
    expect(other.status).toBe(422);
    // Two deliveries at once.
    await Promise.all([settleSession(app, completed(order!)), settleSession(app, completed(order!))]);
    await settleSession(app, completed(order!));
    made.push("shop");
    expect(getOrder(app.db, order!.id)?.state).toBe("spawned");
    expect(placed).toBe(1);
    expect(getStored(app.db, "shop")?.plan).toBe("small");
    const done = await fetch(`${base}/pricing/done?order=${order!.id}`, { headers: { cookie } });
    const text = await done.text();
    expect(text).toContain("shop is ready");
    expect(text).toMatch(/claim|token=|#/i);
    const again = await fetch(`${base}/pricing/done?order=${order!.id}`, { headers: { cookie } });
    expect(await again.text()).toContain("shown already");
    // Someone without the buyer's cookie sees nothing.
    expect((await fetch(`${base}/pricing/done?order=${order!.id}`)).status).toBe(404);
  });

  test("the return page reconciles by session id when no webhook came, once", async () => {
    const { order, cookie } = await buy("lates");
    paidSessions.add(order!.session_id);
    const [a, b] = await Promise.all([reconcileOrder(app, order!.id), reconcileOrder(app, order!.id)]);
    made.push("lates");
    expect([a?.state, b?.state].includes("spawned")).toBe(true);
    expect(getOrder(app.db, order!.id)?.state).toBe("spawned");
    expect(placed).toBe(2);
    const done = await fetch(`${base}/pricing/done?order=${order!.id}`, { headers: { cookie } });
    expect(await done.text()).toContain("lates is ready");
  });

  test("an event for a session that is not the order's settles nothing", async () => {
    const { order } = await buy("forged");
    expect(await settleSession(app, { ...completed(order!), id: "cs_other" })).toBeUndefined();
    expect(getOrder(app.db, order!.id)?.state).toBe("pending");
  });

  test("a paid order whose spawn fails raises the alarm, tells the buyer, and an admin retries it", async () => {
    full = true;
    const { order, cookie } = await buy("nospace");
    await settleSession(app, completed(order!));
    expect(getOrder(app.db, order!.id)?.state).toBe("failed");
    const alarm = alarmPaidOrder(app.db);
    expect(alarm.fired).toBe(true);
    expect(alarm.says).toContain("nospace");
    const done = await fetch(`${base}/pricing/done?order=${order!.id}`, { headers: { cookie } });
    expect(await done.text()).toContain("paid but not made yet");
    expect(firedAlarms(app.db, new Date(), { dataDir: null } as any).some((f) => f.key === "paid_order")).toBe(true);
    // A non-admin cannot retry; an admin can once there is room.
    expect((await retryOrder(app, undefined, order!.id)).ok).toBe(false);
    full = false;
    const retried = await retryOrder(app, admin as any, order!.id);
    made.push("nospace");
    expect(retried.ok && retried.value.state).toBe("spawned");
    expect(alarmPaidOrder(app.db).fired).toBe(false);
  });

  test("with no provider the paid plans say ask the operator and a post builds nothing", async () => {
    useCheckout(app, undefined);
    const text = await (await fetch(`${base}/pricing`)).text();
    expect(text).toContain("Ask the operator");
    expect(text).not.toContain("$19 a month");
    expect((await fetch(`${base}/pricing/order`, form({ name: "nope", plan: "small", email: "b@x.io" }))).status).toBe(409);
    useCheckout(app, fake);
  });
});

describe("/pricing: abuse and lifetimes", () => {
  const url = () => new URL(`${base}/pricing/order`);

  test("one address cannot hold more than its share of names; another address still can", async () => {
    for (let i = 0; i < MAX_PENDING_PER_ADDRESS; i++) {
      const r = await placeOrder(app, { name: `hoard${i}`, plan: "small", email: "h@x.io", address: "203.0.113.7" }, url());
      expect(r.ok).toBe(true);
    }
    const over = await placeOrder(app, { name: "hoardx", plan: "small", email: "h@x.io", address: "203.0.113.7" }, url());
    expect(over.ok).toBe(false);
    expect(app.db.query("SELECT 1 FROM forge_order WHERE name = 'hoardx'").all()).toEqual([]);
    const other = await placeOrder(app, { name: "honest", plan: "small", email: "h@x.io", address: "203.0.113.8" }, url());
    expect(other.ok).toBe(true);
  });

  test("the checkout stops being payable before the name's hold lapses", async () => {
    let seen: number | undefined;
    useCheckout(app, { ...fake, create: async (req) => { seen = req.expiresAt; return fake.create(req); } });
    const now = Date.now();
    const r = await placeOrder(app, { name: "latepay", plan: "small", email: "l@x.io", address: "198.51.100.1" }, url(), now);
    useCheckout(app, fake);
    expect(r.ok).toBe(true);
    expect(seen).toBeDefined();
    // Stripe's least is 30 minutes; the hold is longer than the checkout.
    expect(seen! * 1000 - now).toBeGreaterThanOrEqual(30 * 60_000);
    expect(seen! * 1000).toBeLessThan(now + HOLD_MS);
    expect(CHECKOUT_MS).toBeLessThan(HOLD_MS);
  });

  test("a claim link is mailed again at most once a day per order", async () => {
    const { order } = await buy("mailme");
    await settleSession(app, completed(order!));
    made.push("mailme");
    const sent: unknown[] = [];
    (app.config as any).mailer = async (m: unknown) => { sent.push(m); return { ok: true }; };
    try {
      const now = Date.now();
      await resendLink(app, "mailme", "buyer@example.com", now);
      await resendLink(app, "mailme", "buyer@example.com", now + 11 * 60_000);
      await resendLink(app, "mailme", "buyer@example.com", now + 23 * 3_600_000);
      expect(sent.length).toBe(1);
      await resendLink(app, "mailme", "buyer@example.com", now + 25 * 3_600_000);
      expect(sent.length).toBe(2);
    } finally {
      delete (app.config as any).mailer;
    }
  });

  test("binding a checkout twice, as the hook does for a spawned order, changes nothing the second time", async () => {
    const { order } = await buy("twice");
    const event = { data: { object: { ...completed(order!), mode: "subscription", metadata: { order: order!.id, forge: "twice", plan: "small" } } } };
    await settleSession(app, event.data.object);
    made.push("twice");
    const before = getStored(app.db, "twice");
    expect(bindCheckout(app, event)).toBe(true);
    const once = getStored(app.db, "twice");
    expect(bindCheckout(app, event)).toBe(true);
    const { updatedAt: _a, ...again } = getStored(app.db, "twice")!;
    const { updatedAt: _b, ...first } = once!;
    expect(again).toEqual(first);
    expect(once?.plan).toBe(before?.plan);
    expect(once?.customerId).toBe("cus_1");
  });
});
