// A forge whose billing is `none` sleeps; a wake shows what happened, a pay-again button and how to export; paying wakes it (#11393).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { spawnForge } from "../src/actions/spawn.ts";
import { sealKey, sealWebhook } from "../src/billing/connection.ts";
import { useCheckout } from "../src/billing/checkout.ts";
import { setStripeFetch } from "../src/billing/sync.ts";
import { createUser } from "../src/core/users.ts";
import { ok } from "../src/kernel/result.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { bootHostedChild, childAwake, closeHostedChildren, payAgainGate, resolveHostedChildApp, sleepLapsed, wakeGate } from "../src/spawn/host.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { notePeer } from "../src/http/peer.ts";
import { setStrangerLimits, strangerLimits } from "../src/http/strangers.ts";
import { lapsedForges } from "../src/tui/screens/lapsed.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
const secret = "whsec_lapsed_sleep_secret";
let dir: string;
let app: App;
let servers: Servers;
let status = "active";
let n = 0;
let made: Record<string, unknown>[] = [];

async function deliver(next: string): Promise<void> {
  status = next;
  const body = JSON.stringify({ id: `evt_s${++n}`, type: "customer.subscription.updated", data: { object: { id: "sub_k", status: next } } });
  const t = Math.floor(Date.now() / 1000);
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${body}`)));
  const res = await fetch(`http://127.0.0.1:${servers.port}/hooks/stripe`, {
    method: "POST", headers: { "stripe-signature": `t=${t},v1=${Buffer.from(mac).toString("hex")}`, "x-forwarded-for": `10.8.0.${n}` }, body,
  });
  expect(res.status).toBe(200);
}

const visit = (init: RequestInit = {}, path = "/", headers: Record<string, string> = {}) =>
  new Request(`https://kid--forge.test${path}`, { ...init, headers: { host: "kid--forge.test", accept: "text/html", ...headers } });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lapsed-sleep-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  servers = await serve(app);
  sealKey(app.db, dir, "sk_test_abcdefgh12345678");
  sealWebhook(app.db, dir, secret);
  setStripeFetch(app, (async () =>
    new Response(JSON.stringify({ id: "sub_k", status, customer: "cus_k", metadata: { forge: "kid", plan: "medium" }, items: { data: [{ current_period_end: 1900000000 }] } }), { status: 200 })) as unknown as typeof fetch);
  useCheckout(app, {
    name: "fake",
    create: async (req) => { made.push({ ...req }); return ok({ id: "cs_1", url: "https://pay.test/cs_1" }); },
    state: async () => ok({ paid: false, customer: "", subscription: "" }),
  });
  const admin = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
  if (!admin.ok) throw new Error("user");
  const out = await spawnForge(
    app, admin.value, { name: "kid", org: "kid", apps: [], carryBriefs: false, carrySubscriptions: false },
    { catalog: [], briefs: [], subscriptions: [] },
    { placement: hostedPlacement({ host: "forge.test" }), request: new Request("https://forge.test/spawn", { method: "POST", headers: { origin: "https://forge.test" } }), url: new URL("https://forge.test/spawn") },
  );
  if (!out.ok) throw new Error(JSON.stringify(out.error));
  await bootHostedChild(app, "kid");
});
afterAll(async () => {
  useCheckout(app, undefined);
  setStripeFetch(app, undefined);
  closeHostedChildren(app);
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("a forge whose billing is none", () => {
  test("none → asleep and unwakeable → paid → awake", async () => {
    await deliver("active");
    expect(childAwake(app, "kid")).toBe(true);
    expect(await sleepLapsed(app)).toEqual([]);

    await deliver("canceled");
    expect(await sleepLapsed(app)).toEqual(["kid"]);
    expect(childAwake(app, "kid")).toBe(false);

    // a wake shows the page: what happened, the button, how to export
    const woke = wakeGate(app, visit());
    expect(woke?.status).toBe(402);
    const body = await woke!.text();
    expect(body).toContain("kid is asleep because its subscription ended");
    expect(body).toContain("Pay again");
    expect(body).toContain('action="/pay-again"');
    expect(body).toContain("ask this forge&#39;s operator");
    expect(woke!.headers.get("cache-control")).toBe("no-store");
    // a client that is not a browser gets the sentences
    const plain = wakeGate(app, visit({}, "/", { accept: "application/json" }));
    expect(plain?.status).toBe(402);
    expect(await plain!.text()).toContain("kid is asleep");
    // its apps do not answer, and nothing wakes
    const hit = await resolveHostedChildApp(app, new Request("https://web--kid--forge.test/", { headers: { host: "web--kid--forge.test" } }));
    expect(hit).toMatchObject({ refused: expect.stringContaining("asleep") });
    expect(childAwake(app, "kid")).toBe(false);

    // the button: same-origin only, then the checkout
    expect((await payAgainGate(app, visit({ method: "POST" }, "/pay-again")))?.status).toBe(403);
    expect((await payAgainGate(app, visit({ method: "POST" }, "/pay-again", { origin: "https://evil.test" })))?.status).toBe(403);
    expect(await payAgainGate(app, visit({}, "/pay-again"))).toBeUndefined();
    const paying = await payAgainGate(app, visit({ method: "POST" }, "/pay-again", { origin: "https://kid--forge.test" }));
    expect(paying?.status).toBe(303);
    expect(paying?.headers.get("location")).toBe("https://pay.test/cs_1");
    expect(made[0]).toMatchObject({ forge: "kid", plan: "medium" });

    // paid: the provider's webhook, and it wakes as it was
    await deliver("active");
    expect(await payAgainGate(app, visit({ method: "POST" }, "/pay-again", { origin: "https://kid--forge.test" }))).toBeUndefined();
    const after = wakeGate(app, visit());
    expect(after?.status).not.toBe(402);
    expect(await sleepLapsed(app)).toEqual([]);
  });

  test("pressing pay again is counted per address and refused with 429 past the limit", async () => {
    await deliver("canceled");
    setStrangerLimits(app, { perAddress: { ...strangerLimits(app).perAddress, pay: 2 } });
    const press = (ip: string) => {
      const request = visit({ method: "POST" }, "/pay-again", { origin: "https://kid--forge.test" });
      notePeer(request, ip);
      return payAgainGate(app, request);
    };
    const before = made.length;
    expect((await press("203.0.113.7"))?.status).toBe(303);
    expect((await press("203.0.113.7"))?.status).toBe(303);
    const third = await press("203.0.113.7");
    expect(third?.status).toBe(429);
    expect(third?.headers.get("retry-after")).toBeTruthy();
    expect(made.length).toBe(before + 2);
    // another address has its own minute
    expect((await press("198.51.100.9"))?.status).toBe(303);
  });

  test("the terminal lists the lapsed forge with the sentence and the keep-until line", async () => {
    const admin = { id: "x", username: "alice", isAdmin: true, kind: "person" };
    const rows = lapsedForges({ app, user: admin } as unknown as Session);
    expect(rows.map((r) => r.name)).toEqual(["kid"]);
    expect(rows[0]!.lines[0]).toContain("kid is asleep");
    expect(rows[0]!.lines[1]).toContain("Your data is kept until");
  });
});
