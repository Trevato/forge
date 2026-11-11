// POST /hooks/stripe: a signed event once, 400 on a bad or stale signature, 200 and nothing on a replay (#11244).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { sealKey, sealWebhook } from "../src/billing/connection.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { refusedCount, setStripeHookCaps } from "../src/http/stripe_hook.ts";

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
    const body = evt("evt_audit");
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
});
