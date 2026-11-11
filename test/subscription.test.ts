// A Stripe subscription as an entitlement (#11245): which subscription an event names, how Stripe's answer is read, what is written.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/app.ts";
import { putEntitlement } from "../src/billing/store.ts";
import { stripeClient, type StripeSubscription } from "../src/billing/stripe.ts";
import { entitlementFrom, subscriptionIdOf } from "../src/billing/subscription.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("subscriptionIdOf", () => {
  const ev = (type: string, object: unknown) => ({ type, data: { object } });
  test("a subscription event names its own id; an invoice names its subscription", () => {
    expect(subscriptionIdOf(ev("customer.subscription.updated", { id: "sub_1" }))).toBe("sub_1");
    expect(subscriptionIdOf(ev("invoice.paid", { id: "in_1", subscription: "sub_2" }))).toBe("sub_2");
  });
  test("an invoice in the newer shape names it under parent.subscription_details", () => {
    expect(subscriptionIdOf(ev("invoice.paid", { id: "in_1", parent: { subscription_details: { subscription: "sub_3" } } }))).toBe("sub_3");
  });
  test("an expanded object gives its id", () => {
    expect(subscriptionIdOf(ev("invoice.paid", { subscription: { id: "sub_4" } }))).toBe("sub_4");
  });
  test("malformed or non-sub_ ids name nothing", () => {
    expect(subscriptionIdOf(ev("invoice.paid", { id: "in_1" }))).toBeUndefined();
    expect(subscriptionIdOf(ev("invoice.paid", { subscription: "cus_1" }))).toBeUndefined();
    expect(subscriptionIdOf(ev("customer.subscription.updated", { id: "sub_../x" }))).toBeUndefined();
    expect(subscriptionIdOf(ev("customer.subscription.updated", { id: 5 }))).toBeUndefined();
    expect(subscriptionIdOf(ev("invoice.paid", { subscription: null }))).toBeUndefined();
    expect(subscriptionIdOf({ type: "invoice.paid" })).toBeUndefined();
    expect(subscriptionIdOf(null)).toBeUndefined();
  });
});

describe("getSubscription", () => {
  const read = (body: unknown) =>
    stripeClient("sk_test_abcdefgh12345678", (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch).getSubscription("sub_1");
  test("a customer object gives its id; the period end on an item is read", async () => {
    const r = await read({ id: "sub_1", status: "active", customer: { id: "cus_9" }, items: { data: [{ current_period_end: 42 }] }, metadata: { forge: "a", n: 1 } });
    expect(r).toEqual({ ok: true, value: { id: "sub_1", status: "active", customer: "cus_9", periodEnd: 42, metadata: { forge: "a" } } });
  });
  test("the period end on the subscription wins over none on the item", async () => {
    const r = await read({ id: "sub_1", status: "active", customer: "cus_1", current_period_end: 7 });
    expect(r).toMatchObject({ ok: true, value: { periodEnd: 7, customer: "cus_1" } });
  });
  test("a missing id or status is an error", async () => {
    expect((await read({ status: "active" })).ok).toBe(false);
    expect((await read({ id: "sub_1" })).ok).toBe(false);
  });
});

describe("entitlementFrom", () => {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "sub-")), port: 0 });
  const db: Database = app.db;
  const sub = (o: Partial<StripeSubscription>): StripeSubscription => ({ id: "sub_1", status: "active", customer: "cus_1", periodEnd: 0, metadata: {}, ...o });
  test("a forge nobody named writes nothing", () => {
    expect(entitlementFrom(db, sub({}))).toBeUndefined();
    expect(entitlementFrom(db, sub({ metadata: { forge: "Bad Name!", plan: "medium" } }))).toBeUndefined();
  });
  test("a metadata forge with a known plan is written", () => {
    expect(entitlementFrom(db, sub({ metadata: { forge: "acme", plan: "medium" }, periodEnd: 5 }))).toMatchObject({ forge: "acme", plan: "medium", status: "active", periodEnd: 5 });
  });
  test("an unknown plan with no row writes nothing while paid, and free when not", () => {
    expect(entitlementFrom(db, sub({ metadata: { forge: "acme", plan: "nope" } }))).toBeUndefined();
    expect(entitlementFrom(db, sub({ status: "canceled", metadata: { forge: "acme", plan: "nope" } }))).toMatchObject({ plan: "free", status: "none" });
  });
  test("a known forge is found by its stored subscription id, and keeps its plan when the metadata plan is unknown", () => {
    putEntitlement(db, { forge: "acme", plan: "medium", status: "active", source: "stripe", provider: "stripe", subscriptionId: "sub_1" }, "small", "t");
    expect(entitlementFrom(db, sub({ status: "past_due" }))).toMatchObject({ forge: "acme", plan: "medium", status: "grace" });
    expect(entitlementFrom(db, sub({ metadata: { plan: "nope" } }))).toMatchObject({ forge: "acme", plan: "medium", status: "active" });
  });
});
