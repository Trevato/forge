/**
 * The Stripe connection as stored (#11136): the pasted key and the webhook's
 * signing secret, sealed with the forge's secrets (`core/secret_store.ts`).
 * The mode is in the secret's NAME (`STRIPE_KEY_TEST` or `STRIPE_KEY_LIVE`),
 * so every admin view can say sandbox or live without opening the key.
 * Opening a value is only `openKey`, and it makes the value redacted from
 * logs for the life of the process.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import { deleteSecret, listSecretNames, resolveSecrets, setSecret } from "../core/secret_store.ts";
import { holdValues } from "../kernel/log.ts";
import { modeOf, type StripeMode } from "./stripe.ts";

const KEY_NAME: Record<StripeMode, string> = { sandbox: "STRIPE_KEY_TEST", live: "STRIPE_KEY_LIVE" };
const SECRET = "STRIPE_WEBHOOK_SECRET";
const ENDPOINT = "STRIPE_WEBHOOK_ID";

export interface Connection {
  readonly mode: StripeMode;
  /** True when a signing secret is sealed, so events can be verified. */
  readonly signed: boolean;
}

/** What is connected, from names alone: nothing is opened. */
export function connectionOf(db: Database): Connection | undefined {
  const names = new Set(listSecretNames(db, "forge").map((s) => s.name));
  const mode = names.has(KEY_NAME.live) ? "live" : names.has(KEY_NAME.sandbox) ? "sandbox" : undefined;
  return mode === undefined ? undefined : { mode, signed: names.has(SECRET) };
}

/** Seal the key under its mode's name, forgetting the other mode's. False when it is not a Stripe key. */
export function sealKey(db: Database, dataDir: string, key: string): boolean {
  const mode = modeOf(key);
  if (mode === undefined) return false;
  deleteSecret(db, "forge", "", KEY_NAME[mode === "live" ? "sandbox" : "live"]);
  return setSecret(db, dataDir, "forge", "", KEY_NAME[mode], key).ok;
}

export function sealWebhook(db: Database, dataDir: string, secret: string, endpointId = ""): boolean {
  if (endpointId !== "" && !setSecret(db, dataDir, "forge", "", ENDPOINT, endpointId).ok) return false;
  return setSecret(db, dataDir, "forge", "", SECRET, secret).ok;
}

/** The sealed key and the endpoint id, opened (audited as `secret.read`). */
export function openKey(db: Database, dataDir: string, bus: EventBus, actor: string): { key: string; endpointId: string } | undefined {
  const c = connectionOf(db);
  if (!c) return undefined;
  const got = resolveSecrets(db, dataDir, bus, [KEY_NAME[c.mode], ENDPOINT], { actor });
  const key = got[KEY_NAME[c.mode]];
  if (key === undefined) return undefined;
  holdValues("stripe", [key]);
  return { key, endpointId: got[ENDPOINT] ?? "" };
}

/**
 * The sealed signing secret, opened (audited as `secret.read`); undefined when none is sealed.
 * `quiet` opens it with no audit row, for a caller that audits only what it verified.
 */
export function openWebhookSecret(db: Database, dataDir: string, bus: EventBus, actor?: string, quiet = false): string | undefined {
  if (!connectionOf(db)?.signed) return undefined;
  const secret = resolveSecrets(db, dataDir, bus, [SECRET], { actor, quiet })[SECRET];
  if (secret === undefined || secret === "") return undefined;
  holdValues("stripe", [secret]);
  return secret;
}

export function forget(db: Database): void {
  for (const n of [...Object.values(KEY_NAME), SECRET, ENDPOINT]) deleteSecret(db, "forge", "", n);
}
