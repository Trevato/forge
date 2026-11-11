// POST /hooks/stripe: a signed event once, 400 on a bad or stale signature, 200 and nothing on a replay (#11244).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { sealKey, sealWebhook } from "../src/billing/connection.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getStored } from "../src/billing/store.ts";
import { refusedCount, setStripeHookCaps, setStripeHookFetch } from "../src/http/stripe_hook.ts";

const secret = "whsec_hook_test_secret";
let dir: string;
let app: App;
let servers: Servers;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stripe-hook-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = `http://127.0.0.1:${servers.port}`;
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

async function sign(body: string, key = secret, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${Buffer.from(mac).toString("hex")}`;
}
let n = 0;
const post = (body: string, header: string | undefined, extra: Record<string, string> = {}) =>
  fetch(`${base}/hooks/stripe`, {
    method: "POST",
    headers: { ...(header === undefined ? {} : { "stripe-signature": header }), "x-forwarded-for": `10.3.0.${++n}`, ...extra },
    body,
  });
const events = () => app.db.query("SELECT id, type FROM stripe_event ORDER BY id").all();
const evt = (id: string, type = "invoice.paid") => JSON.stringify({ id, type, data: {} });

describe("POST /hooks/stripe", () => {
  test("answers 404 while no signing secret is sealed", async () => {
    const body = evt("evt_1");
    expect((await post(body, await sign(body))).status).toBe(404);
    expect(events()).toEqual([]);
  });

  test("a signed event is stored once; a replay answers 200 and changes nothing", async () => {
    expect(sealKey(app.db, dir, "sk_test_abcdefgh12345678")).toBe(true);
    expect(sealWebhook(app.db, dir, secret)).toBe(true);
    const body = evt("evt_2");
    const header = await sign(body);
    const first = await post(body, header);
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toBeNull();
    expect((await post(body, header)).status).toBe(200);
    expect(events()).toEqual([{ id: "evt_2", type: "invoice.paid" }]);
  });

  test("an unknown event type answers 200", async () => {
    const body = evt("evt_3", "something.new_and_odd");
    expect((await post(body, await sign(body))).status).toBe(200);
    expect(events()).toContainEqual({ id: "evt_3", type: "something.new_and_odd" });
  });

  test("a cookie is neither needed nor read", async () => {
    const body = evt("evt_4");
    expect((await post(body, await sign(body), { cookie: "forge_session=nope" })).status).toBe(200);
  });

  test("a bad signature answers 400, is counted, and stores nothing", async () => {
    const before = refusedCount(app, "bad");
    const body = evt("evt_5");
    expect((await post(body, await sign(body, "whsec_other"))).status).toBe(400);
    expect((await post(body, undefined)).status).toBe(400);
    expect((await post(evt("evt_6"), await sign(body))).status).toBe(400);
    expect(refusedCount(app, "bad")).toBe(before + 3);
    expect(events().find((e) => (e as { id: string }).id.match(/^evt_[56]$/))).toBeUndefined();
  });

  test("a stale signature answers 400 and is counted", async () => {
    const before = refusedCount(app, "stale");
    const body = evt("evt_7");
    expect((await post(body, await sign(body, secret, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400);
    expect(refusedCount(app, "stale")).toBe(before + 1);
    expect(events().find((e) => (e as { id: string }).id === "evt_7")).toBeUndefined();
  });

  test("a signed body that is not an event answers 400", async () => {
    for (const body of ["not json", JSON.stringify({ type: "x" }), JSON.stringify({ id: "../x", type: "x" })]) {
      expect((await post(body, await sign(body))).status).toBe(400);
    }
  });

  test("an oversize body answers 413", async () => {
    const body = "x".repeat(300 * 1024);
    expect((await post(body, await sign(body))).status).toBe(413);
  });

  test("one client is rate limited", async () => {
    const hit = () => fetch(`${base}/hooks/stripe`, { method: "POST", headers: { "x-forwarded-for": "10.99.0.1" }, body: "{}" });
    let last = 0;
    for (let i = 0; i < 130; i++) last = (await hit()).status;
    expect(last).toBe(429);
  });

  test("an unsigned request writes no secret.read; a verified one writes one", async () => {
    const reads = () => (app.db.query("SELECT COUNT(*) AS n FROM event WHERE kind = 'secret.read'").get() as { n: number }).n;
    const before = reads();
    expect((await post("{}", "t=1,v1=00")).status).toBe(400);
    expect(reads()).toBe(before);
    const body = evt("evt_audit", "ping.neutral"); // a type the hook does not act on, so only the signing secret is opened
    expect((await post(body, await sign(body))).status).toBe(200);
    expect(reads()).toBe(before + 1);
  });

  test("a whole-forge cap answers 429 across clients", async () => {
    setStripeHookCaps(app, 120, 3);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post("{}", "t=1,v1=00")).status); // each from a fresh address
    expect(codes).toEqual([400, 400, 400, 429, 429]);
    setStripeHookCaps(app, 120, 1200);
  });

  test("the daily prune runs only when a day row is first inserted", async () => {
    const old = () => app.db.query("SELECT n FROM stripe_hook_refused WHERE day = '2000-01-01'").get();
    app.db.query("INSERT OR REPLACE INTO stripe_hook_refused (day, kind, n) VALUES ('2000-01-01', 'bad', 5)").run();
    await post("{}", "t=1,v1=00"); // today's row already exists: no prune
    expect(old()).not.toBeNull();
    app.db.query("DELETE FROM stripe_hook_refused WHERE day >= '2001'").run();
    await post("{}", "t=1,v1=00"); // a new day row: prune
    expect(old()).toBeNull();
  });

  describe("subscription and invoice events", () => {
    let nowSub: { status: string };
    let calls: string[];
    let down = false;
    const sub = () => ({ id: "sub_1", status: nowSub.status, customer: "cus_1", metadata: { forge: "acme", plan: "medium" }, items: { data: [{ current_period_end: 1900000000 }] } });
    const ev = (id: string, type: string, status: string) =>
      JSON.stringify({ id, type, data: { object: type.startsWith("invoice.") ? { id: "in_1", subscription: "sub_1", status } : { id: "sub_1", status } } });
    const deliver = async (body: string) => (await post(body, await sign(body))).status;
    beforeAll(() => {
      setStripeHookFetch(app, (async (url: string) => {
        calls.push(String(url));
        if (down) throw new Error("offline");
        return new Response(JSON.stringify(sub()), { status: 200 });
      }) as unknown as typeof fetch);
    });
    afterAll(() => setStripeHookFetch(app, undefined));

    test("events in reverse order end on what Stripe says now, not on the event bodies", async () => {
      calls = [];
      nowSub = { status: "active" };
      // the stale `past_due` event arrives last; its own body says past_due, Stripe says active
      expect(await deliver(ev("evt_s2", "invoice.paid", "paid"))).toBe(200);
      expect(await deliver(ev("evt_s1", "customer.subscription.updated", "past_due"))).toBe(200);
      expect(calls).toEqual(["https://api.stripe.com/v1/subscriptions/sub_1", "https://api.stripe.com/v1/subscriptions/sub_1"]);
      expect(getStored(app.db, "acme")).toMatchObject({ plan: "medium", status: "active", periodEnd: 1900000000, source: "stripe", provider: "stripe", customerId: "cus_1", subscriptionId: "sub_1" });
    });

    test("Stripe unreachable leaves the entitlement as it was and answers 200", async () => {
      const before = getStored(app.db, "acme");
      nowSub = { status: "canceled" };
      down = true;
      expect(await deliver(ev("evt_s3", "customer.subscription.deleted", "canceled"))).toBe(200);
      down = false;
      expect(getStored(app.db, "acme")).toEqual(before!);
    });

    test("a later event re-reads and follows Stripe to canceled", async () => {
      nowSub = { status: "canceled" };
      expect(await deliver(ev("evt_s4", "invoice.payment_failed", "open"))).toBe(200);
      expect(getStored(app.db, "acme")).toMatchObject({ plan: "free", status: "none" });
    });

    test("a replayed event id does not read Stripe again", async () => {
      calls = [];
      nowSub = { status: "active" };
      const body = ev("evt_r1", "invoice.paid", "paid");
      const header = await sign(body);
      expect((await post(body, header)).status).toBe(200);
      expect((await post(body, header)).status).toBe(200);
      expect(calls.length).toBe(1);
    });

    test("deliveries for one subscription are serialised: a slow older read cannot land last", async () => {
      const gates: Array<(status: string) => void> = [];
      setStripeHookFetch(app, (async () =>
        new Promise<Response>((resolve) => {
          gates.push((status) => resolve(new Response(JSON.stringify({ ...sub(), status }), { status: 200 })));
        })) as unknown as typeof fetch);
      const first = deliver(ev("evt_c1", "customer.subscription.updated", "x"));
      await Bun.sleep(30);
      const second = deliver(ev("evt_c2", "customer.subscription.updated", "x"));
      await Bun.sleep(30);
      expect(gates.length).toBe(1); // the second read waits for the first write
      gates[0]!("past_due"); // the first read is the older state
      await Bun.sleep(30);
      expect(gates.length).toBe(2);
      gates[1]!("active");
      expect([await first, await second]).toEqual([200, 200]);
      expect(getStored(app.db, "acme")).toMatchObject({ status: "active" });
    });

    test("a failed read is audited", async () => {
      setStripeHookFetch(app, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
      expect(await deliver(ev("evt_f1", "invoice.paid", "paid"))).toBe(200);
      const n = app.db.query<{ n: number }, []>("SELECT count(*) n FROM event WHERE kind = 'billing.sync_failed'").get()?.n ?? 0;
      expect(n).toBeGreaterThan(0);
    });
  });

  describe("checkout.session.completed", () => {
    const session = (id: string, forge: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        id,
        type: "checkout.session.completed",
        data: { object: { mode: "subscription", payment_status: "paid", customer: "cus_123", subscription: "sub_456", metadata: { forge }, ...extra } },
      });
    const changeCount = (forge: string) => (app.db.query("SELECT COUNT(*) AS n FROM entitlement_change WHERE forge = ?1").get(forge) as { n: number }).n;
    beforeAll(() => {
      mkdirSync(join(dir, "spawn"), { recursive: true });
      writeFileSync(join(dir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "cell-k", done: true, placement: "hosted", size: "small", apps: [], createdAt: new Date().toISOString() }));
    });

    test("binds customer and subscription to the named forge and marks it paid", async () => {
      const body = session("evt_co1", "kid", { metadata: { forge: "kid", plan: "medium" } });
      expect((await post(body, await sign(body))).status).toBe(200);
      expect(getStored(app.db, "kid")).toMatchObject({
        status: "active", plan: "medium", provider: "stripe", customerId: "cus_123", subscriptionId: "sub_456", source: "stripe",
      });
    });

    test("a session for an unknown forge is recorded and changes nothing", async () => {
      const body = session("evt_co2", "ghost");
      expect((await post(body, await sign(body))).status).toBe(200);
      expect(events()).toContainEqual({ id: "evt_co2", type: "checkout.session.completed" });
      expect(getStored(app.db, "ghost")).toBeUndefined();
      expect(changeCount("ghost")).toBe(0);
    });

    test("an unpaid or non-subscription session changes nothing", async () => {
      const before = changeCount("kid");
      const bodies = [
        session("evt_co6", "kid", { payment_status: "unpaid" }),
        session("evt_co7", "kid", { mode: "payment" }),
        session("evt_co8", "kid", { payment_status: undefined }),
      ];
      for (const body of bodies) expect((await post(body, await sign(body))).status).toBe(200);
      expect(changeCount("kid")).toBe(before);
    });

    test("a binding that throws keeps no event id, so the retry binds", async () => {
      app.db.run("CREATE TRIGGER boom BEFORE INSERT ON entitlement_change BEGIN SELECT RAISE(ABORT, 'boom'); END");
      const body = session("evt_co9", "kid", { customer: "cus_retry" });
      expect((await post(body, await sign(body))).status).toBeGreaterThanOrEqual(400); // the server turns a db refusal into an error answer
      app.db.run("DROP TRIGGER boom");
      expect(events().find((e) => (e as { id: string }).id === "evt_co9")).toBeUndefined();
      expect((await post(body, await sign(body))).status).toBe(200);
      expect(getStored(app.db, "kid")?.customerId).toBe("cus_retry");
    });

    test("a malformed session changes nothing", async () => {
      const before = (app.db.query("SELECT COUNT(*) AS n FROM entitlement_change").get() as { n: number }).n;
      for (const [i, body] of [session("evt_co3", 7), session("evt_co4", "kid", { customer: 5 }), session("evt_co5", "../kid")].entries()) {
        expect((await post(body, await sign(body))).status, String(i)).toBe(200);
      }
      expect((app.db.query("SELECT COUNT(*) AS n FROM entitlement_change").get() as { n: number }).n).toBe(before);
    });
  });
});
