// The daily sweep re-reads every subscribed entitlement from Stripe (#11247).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { sealKey } from "../src/billing/connection.ts";
import { getStored, putEntitlement } from "../src/billing/store.ts";
import { setStripeFetch, sweepEntitlements } from "../src/billing/sync.ts";

let dir: string;
let app: App;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stripe-sweep-"));
  app = createApp({ dataDir: dir, port: 0 });
  sealKey(app.db, dir, "sk_test_abcdefgh12345678");
  // bound to a subscription, but its webhook was never delivered: the row still says free
  putEntitlement(app.db, { forge: "acme", plan: "free", status: "none", source: "stripe", provider: "stripe", customerId: "cus_1", subscriptionId: "sub_1" }, "small", "test");
  putEntitlement(app.db, { forge: "beta", plan: "free", status: "none", source: "stripe", provider: "stripe", customerId: "cus_2", subscriptionId: "sub_2" }, "small", "test");
});
afterAll(async () => {
  setStripeFetch(app, undefined);
  await rm(dir, { recursive: true, force: true });
});
const count = (kind: string) => app.db.query<{ n: number }, [string]>("SELECT count(*) n FROM event WHERE kind = ?1").get(kind)?.n ?? 0;

describe("sweepEntitlements", () => {
  test("an unreachable Stripe skips the sweep, says so once, and changes nothing", async () => {
    let calls = 0;
    setStripeFetch(app, (async () => { calls += 1; throw new Error("offline"); }) as unknown as typeof fetch);
    const before = [getStored(app.db, "acme"), getStored(app.db, "beta")];
    expect(await sweepEntitlements(app)).toEqual({ read: 0, skipped: true });
    expect(calls).toBe(1); // stopped at the first failure, not one read per subscription
    expect(count("billing.sweep_skipped")).toBe(1);
    expect([getStored(app.db, "acme"), getStored(app.db, "beta")]).toEqual(before as never);
  });

  test("a refused read leaves that entitlement, is audited, and the sweep carries on", async () => {
    const calls: string[] = [];
    const failedBefore = count("billing.sync_failed");
    setStripeFetch(app, (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("sub_1")) return new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }), { status: 404 });
      return new Response(JSON.stringify({ id: "sub_2", status: "active", customer: "cus_2", metadata: { forge: "beta", plan: "medium" } }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(await sweepEntitlements(app)).toEqual({ read: 1, skipped: false });
    expect(calls.length).toBe(2);
    expect(count("billing.sync_failed") - failedBefore).toBe(1);
    expect(getStored(app.db, "acme")).toMatchObject({ plan: "free", status: "none" });
    expect(getStored(app.db, "beta")).toMatchObject({ plan: "medium", status: "active" });
  });

  test("an entitlement whose webhook never came is healed from Stripe", async () => {
    const calls: string[] = [];
    setStripeFetch(app, (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: String(url).split("/").pop(), status: "active", customer: "cus_1", metadata: { forge: String(url).endsWith("sub_1") ? "acme" : "beta", plan: "medium" }, items: { data: [{ current_period_end: 1900000000 }] } }), { status: 200 });
    }) as unknown as typeof fetch);
    expect(await sweepEntitlements(app)).toEqual({ read: 2, skipped: false });
    expect(calls).toContain("https://api.stripe.com/v1/subscriptions/sub_1");
    expect(getStored(app.db, "acme")).toMatchObject({ plan: "medium", status: "active", periodEnd: 1900000000, source: "stripe" });
  });
});
