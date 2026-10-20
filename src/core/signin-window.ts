/**
 * Sign-in attempts, throttled. The token limiter does not see a password
 * form — a stranger has no credential yet — so guessing a password runs at
 * line speed and each guess costs a slow hash. Three sliding windows, checked
 * before the hash: an account may be tried twenty times a minute, a source
 * sixty, and the forge as a whole two hundred, so neither one account, one
 * source nor every account at once is worth the trying. A person signing in
 * does not notice; a refused attempt is not counted, so the door reopens
 * exactly a window later. One limiter per forge database, so a test's forge
 * never throttles another's. Every door that proves a secret asks here: the
 * password doors through `verifyPasswordThrottled` (`core/users.ts`), the
 * passkey, claim and parent doors with a key of their own. The passkey door
 * is the operator's way in and is not counted in the forge-wide window, so
 * guessing passwords at every account cannot shut it.
 */

import type { Database } from "bun:sqlite";
import { RateLimiter } from "./ratelimit.ts";
import { bucketOf } from "../http/peer.ts";
import { limitValue } from "../settings/limits.ts";

const accounts = new WeakMap<Database, RateLimiter>();
// The third window, by the socket's peer: a source trying many accounts.
const sources = new WeakMap<Database, RateLimiter>();

function limiterOf(map: WeakMap<Database, RateLimiter>, db: Database): RateLimiter {
  let limiter = map.get(db);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: 0, adminPerMinute: 0, enabled: true });
    map.set(db, limiter);
  }
  return limiter;
}

/** The answer to one attempt: refused with a wait, or let through. */
export type SigninAdmission =
  | { readonly admitted: false; readonly retryAfter: number }
  | {
      readonly admitted: true;
      /** The secret proved right: give the attempt back to every window. */
      readonly succeeded: () => void;
    };

/**
 * Count one sign-in attempt at `account` from `address` (the peer's, never
 * anything the client typed), before the secret is checked. An attempt that
 * then proves right is given back, so a person who signs in, or a git client
 * that sends the right password on every request, never fills a window;
 * every wrong guess stays counted.
 */
export function admitSignin(
  db: Database,
  account: string,
  address: string,
  options: { readonly forgeWide?: boolean } = {},
): SigninAdmission {
  const limiter = limiterOf(accounts, db);
  // Read on every attempt, so a change on /admin/limits governs the next one.
  limiter.setLimits({
    perMinute: limitValue(db, "signin.per_account"),
    adminPerMinute: limitValue(db, "signin.per_forge"),
    enabled: true,
  });
  const accountKey = `account:${account.toLowerCase()}`;
  // The one key first: a key already refused must not spend the forge's budget.
  const one = limiter.take(accountKey, "ro");
  if (!one.allowed) return { admitted: false, retryAfter: one.retryAfter };
  const peers = limiterOf(sources, db);
  peers.setLimits({ perMinute: limitValue(db, "signin.per_source"), adminPerMinute: 0, enabled: true });
  const sourceKey = `source:${bucketOf(address)}`;
  const source = peers.take(sourceKey, "ro");
  if (!source.allowed) return { admitted: false, retryAfter: source.retryAfter };
  // The operator's door (a passkey: a signature cannot be guessed) skips the
  // forge-wide window, so a flood of password guesses cannot lock it out.
  const counted = options.forgeWide !== false;
  if (counted) {
    const whole = limiter.take("forge", "admin");
    if (!whole.allowed) return { admitted: false, retryAfter: whole.retryAfter };
  }
  return {
    admitted: true,
    succeeded: () => {
      limiter.refund(accountKey);
      peers.refund(sourceKey);
      if (counted) limiter.refund("forge");
    },
  };
}

/**
 * Count one sign-in attempt, kept whatever it proves: for the doors whose
 * secret is checked elsewhere (passkey, claim, parent). Seconds to wait when
 * refused, or undefined when the attempt may go on.
 */
export function signinWindow(
  db: Database,
  account: string,
  address: string,
  options: { readonly forgeWide?: boolean } = {},
): number | undefined {
  const admission = admitSignin(db, account, address, options);
  return admission.admitted ? undefined : admission.retryAfter;
}
