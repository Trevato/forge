/**
 * The stripe provider (#11136): exact form bodies and headers against a fake
 * fetch, the connection sealed and never shown, the sandbox/live word.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { connectStripe, disconnectStripe, readBilling, saveSigningSecret } from "../src/actions/billing.ts";
import { connectionOf } from "../src/billing/connection.ts";
import { FORGE_STRIPE, STRIPE_VERSION, formBody, modeOf, stripeClient } from "../src/billing/stripe.ts";
import { mayUse } from "../src/apps/cloud.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const KEY = "sk_test_AbCdEf1234567890";
type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fake(answer: (c: Call) => { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const c = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: String(init.body ?? "") };
    calls.push(c);
    const a = answer(c);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("stripe client", () => {
  test("the webhook endpoint: exact form, a fresh idempotency key each attempt, delete", async () => {
    const { f, calls } = fake((c) => (c.method === "DELETE" ? { body: { deleted: true } } : { body: { id: "we_1", secret: "whsec_abcdefgh12" } }));
    const s = stripeClient(KEY, f);
    expect(await s.addWebhook("https://f.test/hooks/stripe")).toEqual({ ok: true, value: { id: "we_1", secret: "whsec_abcdefgh12" } });
    await s.addWebhook("https://f.test/hooks/stripe");
    const c = calls[0]!;
    expect(c.url).toBe("https://api.stripe.com/v1/webhook_endpoints");
    expect(c.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "stripe-version": STRIPE_VERSION, "content-type": "application/x-www-form-urlencoded" });
    expect(decodeURIComponent(c.body)).toBe(
      "url=https://f.test/hooks/stripe&enabled_events[0]=checkout.session.completed&enabled_events[1]=customer.subscription.updated&enabled_events[2]=customer.subscription.deleted&enabled_events[3]=invoice.paid&enabled_events[4]=invoice.payment_failed",
    );
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(calls[1]!.headers["idempotency-key"]).not.toBe(calls[0]!.headers["idempotency-key"]);
    await s.removeWebhook("we_1");
    expect(calls[2]).toMatchObject({ url: "https://api.stripe.com/v1/webhook_endpoints/we_1", method: "DELETE" });
    expect(calls[2]!.headers["idempotency-key"]).toBeUndefined();
  });

  test("modes read, form nesting encodes", () => {
    expect([modeOf("sk_test_abcdefgh"), modeOf("rk_live_abcdefgh"), modeOf("pk_live_abcdefgh")]).toEqual(["sandbox", "live", undefined]);
    expect(formBody({ a: { b: [1, 2] }, c: "x y&z", d: undefined })).toBe("a%5Bb%5D%5B0%5D=1&a%5Bb%5D%5B1%5D=2&c=x%20y%26z");
  });

  test("an error never carries the key or what was sent", async () => {
    const { f } = fake(() => ({ status: 400, body: { error: { code: "bad", message: `bad key ${KEY}` } } }));
    const r = await stripeClient(KEY, f).addWebhook("https://f.test/hooks/stripe");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(KEY);
    const down = await stripeClient(KEY, fake(() => new Error(`connect ${KEY}`)).f).removeWebhook("we_1");
    expect(JSON.stringify(down)).not.toContain(KEY);
    expect(down).toMatchObject({ ok: false, error: { kind: "unreachable" } });
  });

  test("the vendor is declared and mayUse says so", () => {
    expect(mayUse(FORGE_STRIPE, "stripe", "payments")).toBe(true);
    expect(mayUse(FORGE_STRIPE, "stripe", "dns")).toBe(false);
  });
});

describe("connecting stripe", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let token = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stripe-"));
    app = createApp({ dataDir, port: 0, url: "https://f.test" });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!a.ok || !b.ok) throw new Error("user");
    alice = a.value;
    bob = b.value;
    token = createToken(app.db, alice.id, "admin", "admin").token;
  }, 30_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const ok = () => fake(() => ({ body: { id: "we_9", secret: "whsec_abcdefgh12" } }));

  test("a non-admin and a bad key change nothing", async () => {
    const { f, calls } = ok();
    expect(await connectStripe(app, bob, KEY, "", f)).toEqual({ ok: false, error: "not_found" });
    expect(await connectStripe(app, alice, "pk_live_abcdefgh12", "", f)).toEqual({ ok: false, error: "bad_key" });
    expect(await connectStripe(app, alice, KEY, "nope", f)).toEqual({ ok: false, error: "bad_secret" });
    expect(calls).toEqual([]);
    expect(connectionOf(app.db)).toBeUndefined();
  });

  test("a key Stripe rejects is not kept", async () => {
    const { f } = fake(() => ({ status: 401, body: { error: { type: "authentication_error" } } }));
    expect(await connectStripe(app, alice, KEY, "", f)).toEqual({ ok: false, error: "refused" });
    expect(connectionOf(app.db)).toBeUndefined();
  });

  test("a key without permission is kept, told so, and takes a signing secret", async () => {
    const { f } = fake(() => ({ status: 403, body: { error: { type: "invalid_request_error" } } }));
    expect(await connectStripe(app, alice, KEY, "", f)).toEqual({ ok: false, error: "no_permission" });
    expect(connectionOf(app.db)).toEqual({ mode: "sandbox", signed: false });
    expect(saveSigningSecret(app, alice, "nope")).toEqual({ ok: false, error: "bad_secret" });
    expect(saveSigningSecret(app, alice, "whsec_pasted12345")).toEqual({ ok: true, value: { mode: "sandbox", signed: true } });
  });

  test("connect registers the endpoint, seals key and secret, and shows only the mode", async () => {
    await disconnectStripe(app, alice, ok().f);
    const { f, calls } = ok();
    const r = await connectStripe(app, alice, ` ${KEY} `, "", f);
    expect(r).toEqual({ ok: true, value: { mode: "sandbox", signed: true } });
    expect(calls[0]!.body).toContain("url=https%3A%2F%2Ff.test%2Fhooks%2Fstripe");
    const view = readBilling(app, alice);
    expect(view.ok && view.value.stripe).toEqual({ mode: "sandbox", signed: true });
    const rows = JSON.stringify([
      app.db.query("SELECT * FROM secret").all(),
      app.db.query("SELECT payload FROM event").all(),
    ]);
    expect(rows).not.toContain(KEY);
    expect(rows).not.toContain("whsec_abcdefgh12");
  });

  test("a live key reads live; the page says the word and never the key", async () => {
    const live = "rk_live_ZyXwVu0987654321";
    await connectStripe(app, alice, live, "", ok().f);
    expect(connectionOf(app.db)?.mode).toBe("live");
    expect(app.db.query<{ name: string }, []>("SELECT name FROM secret WHERE name LIKE 'STRIPE_KEY%'").all()).toEqual([{ name: "STRIPE_KEY_LIVE" }]);
    const res = await fetch(`${servers.url}/settings/billing`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    expect(text).toContain('data-mode="live"');
    expect(text).not.toContain(live);
  });

  test("the form route is same-origin only, and disconnect removes the endpoint and the secrets", async () => {
    const post = (origin: boolean) =>
      fetch(`${servers.url}/settings/billing/stripe/disconnect`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${token}`, ...(origin ? {} : { origin: "https://evil.example" }) } });
    expect((await post(false)).status).toBe(403);
    expect(connectionOf(app.db)).toBeDefined();
    const { f, calls } = fake(() => ({ body: { deleted: true } }));
    expect(await disconnectStripe(app, bob, f)).toEqual({ ok: false, error: "not_found" });
    expect(await disconnectStripe(app, alice, f)).toEqual({ ok: true, value: true });
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "https://api.stripe.com/v1/webhook_endpoints/we_9" });
    expect(connectionOf(app.db)).toBeUndefined();
    expect(app.db.query("SELECT COUNT(*) AS n FROM secret WHERE name LIKE 'STRIPE_%'").get()).toEqual({ n: 0 });
    expect((await post(true)).status).toBeLessThan(400);
  });

  const form = (path: string, body: Record<string, string>) =>
    fetch(`${servers.url}/settings/billing/stripe/${path}`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const flashOf = async (res: Response): Promise<string> => {
    const to = res.headers.get("location") ?? "/settings/billing";
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await fetch(new URL(to, servers.url), { headers: { authorization: `Bearer ${token}`, cookie } });
    return await page.text();
  };

  test("reconnecting forgets what the last key sealed, and removes its endpoint", async () => {
    await disconnectStripe(app, alice, ok().f);
    await connectStripe(app, alice, KEY, "", ok().f);
    const { f, calls } = fake(() => ({ status: 403, body: { error: { type: "invalid_request_error" } } }));
    const second = "sk_test_ZzZzZz9999999999";
    expect(await connectStripe(app, alice, second, "", f)).toEqual({ ok: false, error: "no_permission" });
    expect(calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    // the old key's endpoint was removed, and its secret and id are gone
    expect(connectionOf(app.db)).toEqual({ mode: "sandbox", signed: false });
    expect(app.db.query("SELECT COUNT(*) AS n FROM secret WHERE name IN ('STRIPE_WEBHOOK_SECRET','STRIPE_WEBHOOK_ID')").get()).toEqual({ n: 0 });
    await connectStripe(app, alice, KEY, "whsec_pasted12345", ok().f);
    expect(app.db.query("SELECT COUNT(*) AS n FROM secret WHERE name = 'STRIPE_WEBHOOK_ID'").get()).toEqual({ n: 0 });
  });

  test("a reconnect with a new endpoint deletes the old one at Stripe", async () => {
    await disconnectStripe(app, alice, ok().f);
    await connectStripe(app, alice, KEY, "", fake(() => ({ body: { id: "we_old", secret: "whsec_oldoldold1" } })).f);
    const { f, calls } = fake((c) => (c.method === "DELETE" ? { body: { deleted: true } } : { body: { id: "we_new", secret: "whsec_newnewnew1" } }));
    expect(await connectStripe(app, alice, "sk_test_Another1234567890", "", f)).toEqual({ ok: true, value: { mode: "sandbox", signed: true } });
    expect(calls.map((c) => `${c.method} ${c.url.split("/").pop()}`)).toEqual(["POST webhook_endpoints", "DELETE we_old"]);
    expect(calls[1]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(await disconnectStripe(app, alice, f)).toEqual({ ok: true, value: true });
    expect(calls[2]).toMatchObject({ method: "DELETE", url: "https://api.stripe.com/v1/webhook_endpoints/we_new" });
  });

  test("disconnect says so when the endpoint could not be removed, and still forgets the key", async () => {
    await connectStripe(app, alice, KEY, "", ok().f);
    const down = fake(() => ({ status: 500, body: {} }));
    expect(await disconnectStripe(app, alice, down.f)).toEqual({ ok: false, error: "left_at_stripe" });
    expect(connectionOf(app.db)).toBeUndefined();
  });

  test("the webhook address is the configured origin, not the request's Host", async () => {
    const { f, calls } = ok();
    await connectStripe(app, alice, KEY, "", f);
    expect(decodeURIComponent(calls[0]!.body)).toContain("url=https://f.test/hooks/stripe&");
    const bare = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-stripe-bare-")), port: 0 });
    const a = await createUser(bare.db, { origin: "seed", trusted: true, username: "carol", email: "c@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("user");
    const none = ok();
    expect(await connectStripe(bare, a.value, KEY, "", none.f)).toEqual({ ok: false, error: "no_origin" });
    expect(none.calls).toEqual([]);
    bare.close();
  });

  test("the connect and secret routes, through HTTP, with their flash words", async () => {
    await disconnectStripe(app, alice, ok().f);
    const bad = await form("connect", { key: "pk_live_abcdefgh12" });
    expect(bad.status).toBeLessThan(400);
    expect(await flashOf(bad)).toContain("That is not a Stripe secret or restricted key");
    expect(connectionOf(app.db)).toBeUndefined();
    // no network in tests: a key and a pasted signing secret seal without a Stripe call
    const good = await form("connect", { key: KEY, secret: "whsec_pasted12345" });
    expect(await flashOf(good)).toContain("Stripe is connected (sandbox).");
    expect(connectionOf(app.db)).toEqual({ mode: "sandbox", signed: true });
    const worse = await form("secret", { secret: "nope" });
    expect(await flashOf(worse)).toContain("A signing secret starts whsec_");
    const saved = await form("secret", { secret: "whsec_another12345" });
    expect(await flashOf(saved)).toContain("Signing secret saved.");
    const asBob = await fetch(`${servers.url}/settings/billing/stripe/connect`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${createToken(app.db, bob.id, "bob", "admin").token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ key: KEY }) });
    expect(asBob.status).toBe(404);
  });
});
