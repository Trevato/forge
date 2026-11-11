/**
 * The Plan row's wiring (#11141): every change to a forge's plan tells that
 * forge (grant, gift, checkout, Stripe sync), a new portal address tells every
 * forge, the portal setting is a person admin's alone and same-origin, and
 * /settings shows the row to an admin and to no one else. Each test fails if
 * the call it names is removed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantPlan } from "../src/actions/billing.ts";
import { makeCode, settleGift } from "../src/actions/codes.ts";
import { changePortalUrl } from "../src/actions/signup.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { bindCheckout } from "../src/billing/checkout_completed.ts";
import { sealKey } from "../src/billing/connection.ts";
import { keepNotice, noticeOf } from "../src/billing/notice.ts";
import { putEntitlement } from "../src/billing/store.ts";
import { setStripeFetch, syncSubscription } from "../src/billing/sync.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getPortalUrl } from "../src/settings/billing.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const PORTAL = "https://billing.stripe.com/p/login/wired";
let dir: string;
let app: App;
let servers: Servers;
let admin: User;
let member: User;

async function child(name: string): Promise<string> {
  const bodyId = `body-${name}`;
  await mkdir(join(dir, "spawn"), { recursive: true });
  await writeFile(join(dir, "spawn", `${name}.json`), JSON.stringify({ name, bodyId, done: true, size: "small", org: name, apps: [] }));
  const cd = childDirOf(app, bodyId);
  await mkdir(cd, { recursive: true });
  await writeFile(join(cd, "parent.json"), JSON.stringify({ upstream: "https://host.example" }));
  return cd;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-wiring-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const make = async (username: string) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", allowReserved: true, adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  admin = await make("owner");
  promote(app.db, admin);
  member = await make("mia");
});
afterAll(async () => {
  setStripeFetch(app, undefined);
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

test("a grant tells that forge its plan", async () => {
  const cd = await child("g1");
  expect(noticeOf(cd)).toBeUndefined();
  expect(grantPlan(app, admin, "g1", "medium").ok).toBe(true);
  expect(noticeOf(cd)).toMatchObject({ name: "Medium", status: "active" });
});

test("a redeemed gift tells the forge its plan", async () => {
  const cd = await child("g2");
  const made = makeCode(app, admin, { plan: "large" }, "http://x");
  if (!made.ok) throw new Error(made.error);
  settleGift(app, made.value.made, "g2");
  expect(noticeOf(cd)).toMatchObject({ name: "Large", status: "active" });
});

test("a completed checkout and a Stripe sync tell the forge, with the portal link for a payer", async () => {
  expect(changePortalUrl(app, admin, PORTAL).ok).toBe(true);
  const cd = await child("g3");
  const bound = bindCheckout(app, { data: { object: { mode: "subscription", payment_status: "paid", customer: "cus_w", subscription: "sub_w", metadata: { forge: "g3", plan: "medium" } } } });
  expect(bound).toBe(true);
  expect(noticeOf(cd)).toMatchObject({ name: "Medium", status: "active", portalUrl: PORTAL });

  sealKey(app.db, dir, "sk_test_abcdefgh12345678");
  setStripeFetch(app, (async () => new Response(JSON.stringify({ id: "sub_w", status: "past_due", customer: "cus_w", metadata: { forge: "g3", plan: "medium" }, items: { data: [{ current_period_end: 1900000000 }] } }), { status: 200 })) as unknown as typeof fetch);
  await syncSubscription(app, "sub_w");
  expect(noticeOf(cd)).toMatchObject({ status: "grace" });
  expect(noticeOf(cd)!.periodEnd).toBeGreaterThan(Date.now() / 1000);
});

test("a new portal address tells every forge; clearing it removes the link", async () => {
  const a = await child("t1");
  const b = await child("t2");
  for (const f of ["t1", "t2"]) putEntitlement(app.db, { forge: f, plan: "medium", status: "active", source: "stripe", provider: "stripe", customerId: `cus_${f}`, subscriptionId: `sub_${f}` }, "small", "");
  const next = "https://billing.stripe.com/p/login/second";
  expect(changePortalUrl(app, admin, next).ok).toBe(true);
  expect(noticeOf(a)?.portalUrl).toBe(next);
  expect(noticeOf(b)?.portalUrl).toBe(next);
  expect(changePortalUrl(app, admin, "").ok).toBe(true);
  expect(noticeOf(a)?.portalUrl).toBeUndefined();
  expect(noticeOf(b)?.portalUrl).toBeUndefined();
});

test("the portal setting refuses a member, an agent and a cross-origin post; nothing changes", async () => {
  const before = getPortalUrl(app.db);
  expect(changePortalUrl(app, member, PORTAL)).toEqual({ ok: false, error: "not_found" });
  expect(changePortalUrl(app, { ...admin, kind: "agent" }, PORTAL)).toEqual({ ok: false, error: "not_found" });
  const post = (cookie: string, origin: string) =>
    fetch(`${servers.url}/settings/billing/portal`, { method: "POST", headers: { cookie, origin, accept: "text/html" }, body: new URLSearchParams({ portal_url: PORTAL }), redirect: "manual" });
  const mine = `forge_session=${createSession(app.db, member.id).token}`;
  const theirs = `forge_session=${createSession(app.db, admin.id).token}`;
  expect((await post(mine, servers.url)).status).toBe(404);
  expect((await post(theirs, "https://evil.test")).status).toBe(403);
  expect(getPortalUrl(app.db)).toBe(before);
  expect((await post(theirs, servers.url)).status).toBe(303);
  expect(getPortalUrl(app.db)).toBe(PORTAL);
});

test("/settings shows the Plan row to an admin and to a member not at all", async () => {
  await writeFile(join(dir, "parent.json"), JSON.stringify({ upstream: "https://host.example" }));
  expect(keepNotice(dir, { name: "Medium", size: "medium", priceUsd: 49, creditUsd: 10, status: "active", portalUrl: PORTAL })).toBe(true);
  const get = async (id: string) => (await fetch(`${servers.url}/settings`, { headers: { cookie: `forge_session=${createSession(app.db, id).token}` } })).text();
  const seen = await get(admin.id);
  expect(seen).toContain("<dt>Plan</dt>");
  expect(seen).toContain(`href="${PORTAL}"`);
  expect(await get(member.id)).not.toContain("<dt>Plan</dt>");
});
