// A forge's billing moves active → grace → none → active as plain data, driven by the fake provider's webhooks (#11391).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { sealKey, sealWebhook } from "../src/billing/connection.ts";
import { lapseFor, lapseOf, statusSince } from "../src/billing/lapse.ts";
import { putEntitlement } from "../src/billing/store.ts";
import { setStripeFetch } from "../src/billing/sync.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { LIMIT_KEYS, LIMITS, limitState, limitStates, setLimit } from "../src/settings/limits.ts";

const secret = "whsec_lapse_test_secret";
const DAY = 86_400_000;
let dir: string;
let app: App;
let servers: Servers;
let now: { status: string };
let n = 0;

async function sign(body: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${body}`)));
  return `t=${t},v1=${Buffer.from(mac).toString("hex")}`;
}
async function deliver(status: string): Promise<void> {
  now = { status };
  const body = JSON.stringify({ id: `evt_l${++n}`, type: "customer.subscription.updated", data: { object: { id: "sub_1", status } } });
  const res = await fetch(`http://127.0.0.1:${servers.port}/hooks/stripe`, {
    method: "POST", headers: { "stripe-signature": await sign(body), "x-forwarded-for": `10.9.0.${n}` }, body,
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "billing-lapse-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  sealKey(app.db, dir, "sk_test_abcdefgh12345678");
  sealWebhook(app.db, dir, secret);
  setStripeFetch(app, (async () =>
    new Response(JSON.stringify({ id: "sub_1", status: now.status, customer: "cus_1", metadata: { forge: "acme", plan: "medium" }, items: { data: [{ current_period_end: 1900000000 }] } }), { status: 200 })) as unknown as typeof fetch);
});
afterAll(async () => {
  setStripeFetch(app, undefined);
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("billing lapse", () => {
  test("grace and retention are settings with a reason, defaulting to 7 and 30 days", () => {
    expect(LIMITS["billing.grace_days"]).toMatchObject({ default: 7 });
    expect(LIMITS["billing.retention_days"]).toMatchObject({ default: 30 });
    expect(LIMITS["billing.grace_days"].reason.length).toBeGreaterThan(10);
    expect(LIMITS["billing.retention_days"].reason.length).toBeGreaterThan(10);
  });

  test("active → grace → none → active through the provider's webhooks", async () => {
    await deliver("active");
    expect(lapseFor(app.db, "acme")).toEqual({ state: "active" });

    await deliver("past_due");
    const t0 = Date.now();
    const g = lapseFor(app.db, "acme", t0);
    expect(g.state).toBe("grace");
    if (g.state !== "grace") throw new Error("unreachable");
    expect(g.graceUntil - g.since).toBe(7 * DAY);
    expect(g.keepUntil - g.graceUntil).toBe(30 * DAY);

    // a repeated past_due does not restart the clock
    await deliver("past_due");
    expect(lapseFor(app.db, "acme", t0)).toEqual(g);

    // grace over: none, kept from where grace ended
    const over = lapseFor(app.db, "acme", g.graceUntil + 1);
    expect(over).toEqual({ state: "none", since: g.graceUntil, keepUntil: g.graceUntil + 30 * DAY });

    // paid again: active at once
    await deliver("active");
    expect(lapseFor(app.db, "acme", g.graceUntil + 1)).toEqual({ state: "active" });
  });

  test("cancelled is none from the change, kept for the retention setting", async () => {
    await deliver("canceled");
    const l = lapseFor(app.db, "acme");
    expect(l.state).toBe("none");
    if (l.state !== "none") throw new Error("unreachable");
    expect(l.keepUntil - l.since).toBe(30 * DAY);
    await deliver("active");
    expect(lapseFor(app.db, "acme")).toEqual({ state: "active" });
  });

  test("the settings govern: a 2 day grace and 10 day retention", async () => {
    expect(setLimit(app.db, "billing.grace_days", 2, "test").ok).toBe(true);
    expect(setLimit(app.db, "billing.retention_days", 10, "test").ok).toBe(true);
    await deliver("past_due");
    const g = lapseFor(app.db, "acme");
    if (g.state !== "grace") throw new Error("not grace");
    expect(g.graceUntil - g.since).toBe(2 * DAY);
    expect(g.keepUntil - g.graceUntil).toBe(10 * DAY);
  });

  test("free plan and granted entitlements are always active", () => {
    const base = { subscribed: false, since: 0 };
    expect(lapseOf({ ...base, plan: "free", status: "none", source: "stripe" }, 1e15, 7, 30)).toEqual({ state: "active" });
    expect(lapseOf({ ...base, plan: "medium", status: "none", source: "granted" }, 1e15, 7, 30)).toEqual({ state: "active" });
    putEntitlement(app.db, { forge: "gift", plan: "medium", status: "grace", source: "granted", provider: "none" }, "small", "u");
    expect(lapseFor(app.db, "gift", Date.now() + 400 * DAY)).toEqual({ state: "active" });
    expect(lapseFor(app.db, "no-row")).toEqual({ state: "active" });
  });

  test("since survives a long run of same-status rows", () => {
    const ins = app.db.query(
      "INSERT INTO entitlement_change (forge, from_plan, to_plan, from_status, to_status, source, actor_id, at) VALUES ('long', 'medium', 'medium', ?1, ?2, 'stripe', 'u', ?3)",
    );
    ins.run("active", "grace", "2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 80; i++) ins.run("grace", "grace", "2026-01-02T00:00:00.000Z");
    expect(statusSince(app.db, "long", "grace")).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(statusSince(app.db, "long", "active")).toBeUndefined();
  });

  test("limitStates agrees with limitState for every limit", () => {
    const all = limitStates(app.db, LIMIT_KEYS);
    for (const k of LIMIT_KEYS) expect(all.get(k)).toEqual(limitState(app.db, k));
  });
});
