/**
 * Write an entitlement from the subscription as Stripe has it now (#11245),
 * and the daily sweep that does it for every subscription the forge holds
 * (#11247). The webhook and the sweep share `syncSubscription`, so a missed
 * hook heals the same way a delivered one writes. Reads and writes for one
 * subscription run one at a time, so the last write is always from the last
 * read. Stripe unreachable or refusing leaves the entitlement as it was and
 * is audited: nothing here ever downgrades on a failed read.
 */

import type { App } from "../app.ts";
import { listChildrenNow } from "../actions/spawn.ts";
import { tellPlan } from "./notice.ts";
import { openKey } from "./connection.ts";
import { getStored, putEntitlement } from "./store.ts";
import { stripeClient, type StripeError } from "./stripe.ts";
import { entitlementFrom } from "./subscription.ts";

const fetches = new WeakMap<App, typeof fetch>();
/** Replace the fetch this app reads Stripe with; for tests. */
export function setStripeFetch(app: App, f: typeof fetch | undefined): void {
  if (f === undefined) fetches.delete(app);
  else fetches.set(app, f);
}

const chains = new Map<string, Promise<void>>();
/** Run `job` after every earlier job for the same key finished, so read and write are one critical section. */
function serialised(key: string, job: () => Promise<void>): Promise<void> {
  const run = (chains.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** Re-read one subscription and write its entitlement; the failure kind when Stripe could not be read, else undefined. */
export async function syncSubscription(app: App, id: string | undefined): Promise<StripeError["kind"] | undefined> {
  const opened = openKey(app.db, app.config.dataDir, app.bus, undefined);
  if (id === undefined || opened === undefined) return undefined;
  let failed: StripeError["kind"] | undefined;
  await serialised(id, async () => {
    const read = await stripeClient(opened.key, fetches.get(app) ?? fetch).getSubscription(id);
    if (!read.ok) {
      failed = read.error.kind;
      app.bus.append({ kind: "billing.sync_failed", payload: { subscription: id, reason: read.error.kind } });
      return;
    }
    const put = entitlementFrom(app.db, read.value);
    if (put === undefined) return;
    const size = listChildrenNow(app).find((c) => c.name === put.forge)?.size ?? getStored(app.db, put.forge)?.plan ?? "small";
    putEntitlement(app.db, put, size, "stripe");
    tellPlan(app, put.forge);
  });
  return failed;
}

/**
 * Every entitlement bound to a subscription, re-read and rewritten. An
 * unreachable Stripe ends the sweep with one audit row (`billing.sweep_skipped`)
 * instead of one failure per subscription; entitlements stay as they were.
 */
export async function sweepEntitlements(app: App): Promise<{ read: number; skipped: boolean }> {
  const ids = app.db
    .query<{ subscription_id: string }, []>("SELECT subscription_id FROM entitlement WHERE subscription_id != '' AND provider = 'stripe' ORDER BY forge")
    .all()
    .map((r) => r.subscription_id);
  let read = 0;
  for (const id of ids) {
    let failed: StripeError["kind"] | undefined;
    try {
      failed = await syncSubscription(app, id);
    } catch {
      failed = "unreachable";
    }
    if (failed === "unreachable") {
      app.bus.append({ kind: "billing.sweep_skipped", payload: { reason: "unreachable", read } });
      return { read, skipped: true };
    }
    if (failed === undefined) read += 1;
  }
  return { read, skipped: false };
}
