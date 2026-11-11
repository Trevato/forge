/**
 * POST /hooks/stripe (#11244): where Stripe tells the forge what happened.
 * Public and cookie-free: the handler never reads a cookie or sets one, and
 * the signature is the only credential. The raw body is read first (bounded),
 * checked with `verifyStripeSignature` against the sealed webhook secret, and
 * only then parsed. A bad or stale signature is 400 and counted per UTC day
 * (`stripe_hook_refused`). A verified event's id is stored once; a repeated id
 * is 200 and does nothing, and so is an event type nobody acts on yet.
 * `checkout.session.completed` binds its forge (`billing/checkout_completed.ts`).
 * A `customer.subscription.*` or `invoice.*` event only names a subscription: the
 * hook re-reads it from Stripe and writes the entitlement from that, one
 * subscription at a time, so events out of order end on the current state.
 */

import type { App } from "../app.ts";
import { listChildrenNow } from "../actions/spawn.ts";
import { bindCheckout } from "../billing/checkout_completed.ts";
import { openKey, openWebhookSecret } from "../billing/connection.ts";
import { getStored, putEntitlement } from "../billing/store.ts";
import { stripeClient } from "../billing/stripe.ts";
import { entitlementFrom, subscriptionIdOf } from "../billing/subscription.ts";
import { verifyStripeSignature } from "../billing/signature.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { Ctx } from "./context.ts";
import { readBounded } from "./limits.ts";
import { clientBucket } from "./peer.ts";

export const STRIPE_HOOK_MAX = 256 * 1024;
const PER_CLIENT = 120;
const WHOLE_FORGE = 1200;
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,200}$/;
const EVENT_TYPE = /^[a-z0-9_.]{1,100}$/;

interface Buckets {
  client: RateLimiter;
  forge: RateLimiter;
}
const limits = new WeakMap<App, Buckets>();

const bucketsOf = (app: App, perClient = PER_CLIENT, wholeForge = WHOLE_FORGE): Buckets => {
  const found = limits.get(app);
  if (found !== undefined) return found;
  const made = {
    client: new RateLimiter({ perMinute: perClient, adminPerMinute: perClient, enabled: true }),
    forge: new RateLimiter({ perMinute: wholeForge, adminPerMinute: wholeForge, enabled: true }),
  };
  limits.set(app, made);
  return made;
};

/** Replace this app's caps (per client, whole forge) and reset their counts; for tests. */
export function setStripeHookCaps(app: App, perClient: number, wholeForge: number): void {
  limits.delete(app);
  bucketsOf(app, perClient, wholeForge);
}

const fetches = new WeakMap<App, typeof fetch>();
/** Replace the fetch this app's hook reads Stripe with; for tests. */
export function setStripeHookFetch(app: App, f: typeof fetch | undefined): void {
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

/**
 * Write the entitlement from the subscription as Stripe has it now, never from
 * the event's body. Reads and writes for one subscription run one at a time, so
 * the last write is always from the last read. Stripe unreachable or refusing
 * leaves the entitlement as it was (and is audited): the hook still answers
 * 200, so Stripe does not retry into a stale read.
 */
async function syncSubscription(app: App, event: unknown): Promise<void> {
  const id = subscriptionIdOf(event);
  const opened = openKey(app.db, app.config.dataDir, app.bus, undefined);
  if (id === undefined || opened === undefined) return;
  await serialised(id, async () => {
    const read = await stripeClient(opened.key, fetches.get(app) ?? fetch).getSubscription(id);
    if (!read.ok) {
      app.bus.append({ kind: "billing.sync_failed", payload: { subscription: id, reason: read.error.kind } });
      return;
    }
    const put = entitlementFrom(app.db, read.value);
    if (put === undefined) return;
    const size = listChildrenNow(app).find((c) => c.name === put.forge)?.size ?? getStored(app.db, put.forge)?.plan ?? "small";
    putEntitlement(app.db, put, size, "stripe");
  });
}

const answer = (status: number, headers?: Record<string, string>): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });

/** Bad and stale signatures refused today and earlier, by kind. */
export function refusedCount(app: App, kind: "bad" | "stale"): number {
  return (
    app.db.query<{ n: number }, [string]>("SELECT COALESCE(SUM(n), 0) AS n FROM stripe_hook_refused WHERE kind = ?1").get(kind)?.n ?? 0
  );
}

function countRefused(app: App, kind: "bad" | "stale", now: Date): void {
  const row = app.db
    .query<{ n: number }, [string, string]>(
      "INSERT INTO stripe_hook_refused (day, kind, n) VALUES (?1, ?2, 1) ON CONFLICT (day, kind) DO UPDATE SET n = n + 1 RETURNING n",
    )
    .get(now.toISOString().slice(0, 10), kind);
  // Prune only when today's row for this kind was just created: once a day, not per refusal.
  if (row?.n !== 1) return;
  app.db.query("DELETE FROM stripe_hook_refused WHERE day < ?1").run(new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10));
}

export async function stripeHook(ctx: Ctx): Promise<Response> {
  const { request, app } = ctx;
  const { client, forge } = bucketsOf(app);
  for (const [bucket, key] of [[client, clientBucket(request)], [forge, "forge"]] as const) {
    const verdict = bucket.take(key, "ro");
    if (!verdict.allowed) return answer(429, { "retry-after": String(Math.max(1, verdict.retryAfter)) });
  }

  const secret = openWebhookSecret(app.db, app.config.dataDir, app.bus, undefined, true);
  if (secret === undefined) return answer(404);

  const raw = await readBounded(request, STRIPE_HOOK_MAX);
  if (raw === "too_large") return answer(413);
  const now = new Date();
  const checked = await verifyStripeSignature(raw, request.headers.get("stripe-signature") ?? "", secret, Math.floor(now.getTime() / 1000));
  if (checked !== "ok") {
    countRefused(app, checked, now);
    return answer(400);
  }
  // The secret was opened quietly above; the audit row says it opened a verified event, once.
  app.bus.append({ kind: "secret.read", payload: { name: "STRIPE_WEBHOOK_SECRET", scope: "forge", run: "stripe-hook" } });

  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return answer(400);
  }
  const e = event as { id?: unknown; type?: unknown } | null;
  if (e === null || typeof e !== "object" || typeof e.id !== "string" || !EVENT_ID.test(e.id)) return answer(400);
  const type = typeof e.type === "string" && EVENT_TYPE.test(e.type) ? e.type : "unknown";
  // A repeated id changes nothing: the primary key refuses it.
  // One transaction: if binding throws, the id is not kept, so Stripe's retry is not taken for a replay.
  const fresh = app.db.transaction(() => {
    const stored = app.db.query("INSERT OR IGNORE INTO stripe_event (id, type, at) VALUES (?1, ?2, ?3)").run(e.id as string, type, now.toISOString());
    if (stored.changes === 1 && type === "checkout.session.completed") bindCheckout(app, event);
    return stored.changes === 1;
  })();
  if (fresh && (type.startsWith("customer.subscription.") || type.startsWith("invoice."))) {
    try {
      await syncSubscription(app, event);
    } catch (cause) {
      // never let a read of Stripe turn into a retry storm; the audit says it failed
      app.bus.append({ kind: "billing.sync_failed", payload: { event: e.id, reason: cause instanceof Error ? cause.name : "error" } });
    }
  }
  return answer(200);
}
