// A payment webhook delivered twice changes nothing the second time (#11866): one case per event the forge handles.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { sealKey, sealWebhook } from "../src/billing/connection.ts";
import { lapseFor } from "../src/billing/lapse.ts";
import { changesOf, getStored } from "../src/billing/store.ts";
import { setStripeFetch } from "../src/billing/sync.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { refusedCount, ALREADY_HANDLED } from "../src/http/stripe_hook.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { ok } from "../src/kernel/result.ts";
import { placeOrder } from "../src/actions/order.ts";
import { useCheckout, type CheckoutProvider } from "../src/billing/checkout.ts";
import { createUser } from "../src/core/users.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";

const secret = "whsec_replay_test_secret";
let dir: string;
let app: App;
let servers: Servers;
let status = "active";
let placed = 0;
let mails = 0;
let n = 0;

async function sign(body: string, key = secret, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${Buffer.from(mac).toString("hex")}`;
}
const post = (body: string, header: string) =>
  fetch(`http://127.0.0.1:${servers.port}/hooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "x-forwarded-for": `10.8.0.${++n}` }, body });
const count = (sql: string): number => app.db.query<{ n: number }, []>(sql).get()?.n ?? 0;

const fake: CheckoutProvider = {
  name: "fake",
  async create(req) { const id = `cs_replay_${req.orderId.slice(4, 16)}`; return ok({ id, url: `https://pay.fake.test/${id}` }); },
  async state() { return ok({ paid: true, customer: "cus_1", subscription: "sub_1" }); },
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "billing-replay-"));
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/forge-code", mailer: async () => { mails++; return true; } });
  servers = await serve(app);
  sealKey(app.db, dir, "sk_test_abcdefgh12345678");
  sealWebhook(app.db, dir, secret);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("user");
  const code = await createRepo(app, a.value, { name: "forge-code", visibility: "public" });
  if (!code.ok) throw new Error("code repo");
  await commitToBranch(app, a.value, code.value, { message: "v1", files: [{ path: "src/main.ts", content: "console.log('forge')" }] });
  useProbe(app, () => async () => true);
  usePlacement(app, { place: async (plan) => ok({ url: `https://${plan.name}.fake.test`, bodyId: `fake-${++placed}` }), retire: async () => ok() });
  useCheckout(app, fake);
  setStripeFetch(app, (async () =>
    new Response(JSON.stringify({ id: "sub_1", status, customer: "cus_1", metadata: { forge: "acme", plan: "medium" }, items: { data: [{ current_period_end: 1900000000 }] } }), { status: 200 })) as unknown as typeof fetch);
}, 30_000);
afterAll(async () => {
  setStripeFetch(app, undefined);
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** Deliver the same signed body twice; the first is handled, the second is told so. */
async function twice(body: string): Promise<void> {
  const header = await sign(body);
  const first = await post(body, header);
  expect(first.status).toBe(200);
  expect(await first.text()).not.toContain(ALREADY_HANDLED);
  const second = await post(body, header);
  expect(second.status).toBe(200);
  expect(await second.text()).toContain(ALREADY_HANDLED);
}

describe("a replayed webhook changes nothing", () => {
  test("checkout completed: one forge, one order row, one entitlement change, no mail", async () => {
    const placedOrder = await placeOrder(app, { name: "shop", plan: "small", email: "buyer@example.com", address: "203.0.113.9" }, new URL(`http://127.0.0.1:${servers.port}/`));
    if (!placedOrder.ok) throw new Error("order");
    const order = app.db.query<{ id: string; session_id: string }, []>("SELECT id, session_id FROM forge_order").get()!;
    const body = JSON.stringify({ id: "evt_checkout", type: "checkout.session.completed", data: { object: { id: order.session_id, metadata: { order: order.id }, customer: "cus_9", subscription: "sub_shop", mode: "subscription", payment_status: "paid" } } });
    const header = await sign(body);
    const placedStart = placed;
    expect((await post(body, header)).status).toBe(200);
    expect(placed - placedStart).toBe(1);
    const orders = count("SELECT COUNT(*) AS n FROM forge_order");
    const changes = changesOf(app.db, "shop").length;
    const events = count("SELECT COUNT(*) AS n FROM stripe_event");
    const placedBefore = placed;
    // The hook sends no mail at all, so this only guards against one being added later.
    const mailsBefore = mails;
    const again = await post(body, header);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain(ALREADY_HANDLED);
    expect(placed).toBe(placedBefore);
    expect(count("SELECT COUNT(*) AS n FROM forge_order")).toBe(orders);
    expect(changesOf(app.db, "shop").length).toBe(changes);
    expect(count("SELECT COUNT(*) AS n FROM stripe_event")).toBe(events);
    expect(mails).toBe(mailsBefore);
  });

  test("payment failed: the grace clock does not move on the second delivery", async () => {
    status = "active";
    await twice(JSON.stringify({ id: "evt_active", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } }));
    status = "past_due";
    const body = JSON.stringify({ id: "evt_failed", type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } });
    const header = await sign(body);
    expect((await post(body, header)).status).toBe(200);
    const t0 = Date.now();
    const lapse = lapseFor(app.db, "acme", t0);
    expect(lapse.state).toBe("grace");
    const changes = changesOf(app.db, "acme").length;
    const stored = getStored(app.db, "acme");
    await Bun.sleep(15);
    const again = await post(body, header);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain(ALREADY_HANDLED);
    expect(lapseFor(app.db, "acme", t0)).toEqual(lapse);
    expect(changesOf(app.db, "acme").length).toBe(changes);
    expect(getStored(app.db, "acme")).toEqual(stored);
  });

  test("subscription cancelled: second delivery adds no change and keeps the lapse", async () => {
    status = "canceled";
    const body = JSON.stringify({ id: "evt_cancel", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
    const header = await sign(body);
    expect((await post(body, header)).status).toBe(200);
    const lapse = lapseFor(app.db, "acme");
    expect(lapse.state).toBe("none");
    const changes = changesOf(app.db, "acme").length;
    await Bun.sleep(15);
    const again = await post(body, header);
    expect(await again.text()).toContain(ALREADY_HANDLED);
    expect(lapseFor(app.db, "acme")).toEqual(lapse);
    expect(changesOf(app.db, "acme").length).toBe(changes);
    expect(mails).toBe(0);
  });
});

describe("the guard", () => {
  const body = JSON.stringify({ id: "evt_guard", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });

  test("a bad signature is refused, counted, and its event is not kept", async () => {
    const before = refusedCount(app, "bad");
    const res = await post(body, await sign(body, "whsec_someone_else"));
    expect(res.status).toBe(400);
    expect(refusedCount(app, "bad")).toBe(before + 1);
    expect(count("SELECT COUNT(*) AS n FROM stripe_event WHERE id = 'evt_guard'")).toBe(0);
  });

  test("a validly signed but old timestamp is refused as stale", async () => {
    const before = refusedCount(app, "stale");
    const old = Math.floor(Date.now() / 1000) - 3600;
    const res = await post(body, await sign(body, secret, old));
    expect(res.status).toBe(400);
    expect(refusedCount(app, "stale")).toBe(before + 1);
    expect(count("SELECT COUNT(*) AS n FROM stripe_event WHERE id = 'evt_guard'")).toBe(0);
  });
});
