/**
 * The `stripe` provider of the Billing seam (#11136): Stripe over `fetch`
 * and nothing else, no SDK. The owner pastes one secret or restricted key;
 * checkout uses inline `price_data`, so nothing is set up in Stripe's
 * dashboard. Plain data in, a Result out. A key is held only in the closure
 * of `stripeClient`: it goes in one `Authorization` header and into no error,
 * no log line and no argument list. A failed call says what Stripe said
 * about the request (its status and error code), never what was sent.
 *
 * The vendor is declared (`FORGE_STRIPE`, docs/CLOUD.md) and every call asks
 * `mayUse` first. The way out: disconnect removes the webhook endpoint and
 * the sealed key; the entitlements stay in the store.
 */

import { mayUse } from "../apps/cloud.ts";
import type { CloudDeclaration } from "../apps/manifest.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const STRIPE_API = "https://api.stripe.com";
/** The one API version every call is pinned to. */
export const STRIPE_VERSION = "2025-09-30.clover";
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

/** What the forge declares for itself: the only vendor its own process calls. */
export const FORGE_STRIPE: readonly CloudDeclaration[] = [
  { vendor: "stripe", use: "payments", why: "the plans payment webhook; leave by disconnecting" },
];

export type StripeMode = "sandbox" | "live";
const KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/;

export const isStripeKey = (key: string): boolean => KEY.test(key);

/** `sandbox` for a test key, `live` for a live one; undefined when it is no Stripe key. */
export function modeOf(key: string): StripeMode | undefined {
  const m = KEY.exec(key);
  return m ? (m[2] === "test" ? "sandbox" : "live") : undefined;
}

export type StripeError =
  | { kind: "permission"; message: string }
  | { kind: "rejected"; message: string; status: number }
  | { kind: "unreachable"; message: string };

type Value = string | number | boolean | undefined | Value[] | { [k: string]: Value };

/** Stripe's form encoding: nested keys in brackets, arrays by index. */
export function formBody(data: { [k: string]: Value }): string {
  const parts: string[] = [];
  const add = (name: string, v: Value): void => {
    if (v === undefined) return;
    if (Array.isArray(v)) v.forEach((x, i) => add(`${name}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) add(`${name}[${k}]`, x);
    else parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(data)) add(k, v);
  return parts.join("&");
}

export interface StripeClient {
  addWebhook(url: string): Promise<Result<{ id: string; secret: string }, StripeError>>;
  removeWebhook(id: string): Promise<Result<true, StripeError>>;
  /** The subscription as Stripe has it now. */
  getSubscription(id: string): Promise<Result<StripeSubscription, StripeError>>;
}

/** The parts of a Stripe subscription the entitlement is written from. */
export interface StripeSubscription {
  readonly id: string;
  readonly status: string;
  readonly customer: string;
  /** Unix seconds; 0 when Stripe gave none. */
  readonly periodEnd: number;
  readonly metadata: Readonly<Record<string, string>>;
}

const PERMISSION = "This key may not create webhook endpoints. Paste a signing secret from Stripe's webhook page instead.";

export function stripeClient(key: string, fetchFn: typeof fetch = fetch): StripeClient {
  const call = async (method: "GET" | "POST" | "DELETE", path: string, data?: { [k: string]: Value }, idem?: string): Promise<Result<Record<string, unknown>, StripeError>> => {
    if (!mayUse(FORGE_STRIPE, "stripe", "payments")) return err({ kind: "unreachable", message: "Stripe is not declared for this forge." });
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, "stripe-version": STRIPE_VERSION };
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded";
      if (idem) headers["idempotency-key"] = idem;
    }
    let res: Response;
    try {
      res = await fetchFn(`${STRIPE_API}${path}`, { method, headers, ...(method === "POST" ? { body: formBody(data ?? {}) } : {}) });
    } catch {
      return err({ kind: "unreachable", message: "Stripe could not be reached." });
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // an empty or non-JSON body: the status says enough
    }
    if (res.ok) return ok(json);
    const e = (json["error"] ?? {}) as Record<string, unknown>;
    const code = typeof e["code"] === "string" ? e["code"] : typeof e["type"] === "string" ? e["type"] : "error";
    if (res.status === 403 || e["type"] === "invalid_request_error" && res.status === 401) return err({ kind: "permission", message: PERMISSION });
    return err({ kind: "rejected", status: res.status, message: `Stripe refused the request (${res.status}, ${String(code).replace(/[^\w.-]/g, "").slice(0, 60)}).` });
  };
  const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");
  const missing = (what: string): StripeError => ({ kind: "rejected", status: 502, message: `Stripe's answer had no ${what}.` });

  return {
    async addWebhook(url) {
      const r = await call("POST", "/v1/webhook_endpoints", { url, enabled_events: [...WEBHOOK_EVENTS] },
        // fresh per attempt: Stripe replays an answer for a repeated key for 24h, and a reconnect must not get a deleted endpoint back
        crypto.randomUUID());
      if (!r.ok) return r;
      const id = str(r.value, "id"), secret = str(r.value, "secret");
      return id && secret ? ok({ id, secret }) : err(missing("signing secret"));
    },
    async removeWebhook(id) {
      const r = await call("DELETE", `/v1/webhook_endpoints/${encodeURIComponent(id)}`);
      return r.ok ? ok(true as const) : r;
    },
    async getSubscription(id) {
      const r = await call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
      if (!r.ok) return r;
      const v = r.value;
      if (str(v, "id") === "" || str(v, "status") === "") return err(missing("subscription"));
      const customer = typeof v["customer"] === "object" && v["customer"] !== null ? str(v["customer"] as Record<string, unknown>, "id") : str(v, "customer");
      // the period end is on the subscription in older API versions and on its first item in newer ones
      const item = ((v["items"] as { data?: unknown } | undefined)?.data as Record<string, unknown>[] | undefined)?.[0];
      const end = [v["current_period_end"], item?.["current_period_end"]].find((n) => typeof n === "number") as number | undefined;
      const metadata: Record<string, string> = {};
      for (const [k, x] of Object.entries((v["metadata"] ?? {}) as Record<string, unknown>)) if (typeof x === "string") metadata[k] = x;
      return ok({ id: str(v, "id"), status: str(v, "status"), customer, periodEnd: end ?? 0, metadata });
    },
  };
}
