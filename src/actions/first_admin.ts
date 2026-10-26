/**
 * Redeeming a first-admin code (`core/first_admin.ts`): the one path both
 * doors share. The code is spent before the account is made, so of two
 * redemptions racing on one code exactly one makes an admin; a refusal
 * after that puts it back. On a spawned child the organisation is handed
 * over exactly as a claim would (`spawn/claim.ts`). The audit keeps who was
 * made, how and from where; the code itself is never logged.
 *
 * Every look at a code goes through `firstAdminProblem` or
 * `redeemFirstAdmin`, and both take the attempt from the address's and the
 * forge's budget before the code is read, so no door can skip the throttle.
 * The account is made under one named origin, the operator's first admin:
 * an exemption from the signup policy as a claim is (the operator vouches),
 * never a stranger's door.
 */

import type { App } from "../app.ts";
import {
  burnFirstAdmin,
  burnFirstAdminRecovery,
  readFirstAdmin,
  unburnFirstAdmin,
} from "../core/first_admin.ts";
import { LIFETIMES } from "../core/oauth.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { createToken } from "./users.ts";
import type { TokenScope } from "../core/tokens.ts";
import { createUser, discardFreshUser, getUserById, getUserByName, type User } from "../core/users.ts";
import { bucketOf } from "../http/peer.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { limitValue } from "../settings/limits.ts";
import { handOver, spawnedOrg } from "../spawn/claim.ts";
import { EMAIL_TAKEN_MESSAGE, EMAIL_WANTED, INVALID_USERNAME_MESSAGE, NAME_RESERVED, USERNAME_TAKEN } from "./signup_words.ts";

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

export type FirstAdminError =
  | "rate_limited"
  | "refused"
  | "invalid_username"
  | "invalid_email"
  | "username_taken"
  | "email_taken"
  | "username_reserved"
  | "unfinished";

/** The words for each refusal, written for anyone; "refused" never says which of wrong, used, expired or owned. */
export const FIRST_ADMIN_WORDS: Record<FirstAdminError, string> = {
  rate_limited: "Too many attempts from here. Wait a minute and try again.",
  refused:
    "That first-admin code does not work: it may be mistyped, used, expired or replaced, or this forge already has an admin. Ask the operator to run --first-admin again.",
  invalid_username: INVALID_USERNAME_MESSAGE,
  invalid_email: EMAIL_WANTED,
  username_taken: USERNAME_TAKEN,
  email_taken: EMAIL_TAKEN_MESSAGE,
  username_reserved: NAME_RESERVED,
  unfinished: "The account could not be finished. Try again.",
};

/** The account's origin, for the audit and for the one gate where accounts are made. */
export const FIRST_ADMIN_ORIGIN = "first-admin";
/** A stranded admin's new token, in the audit. No account is made on this path. */
export const FIRST_ADMIN_RECOVERY = "first-admin-recovery";

/**
 * How long the headless first admin's token lives, in seconds. It always
 * expires: by default in a day, the shortest lifetime a person can pick for
 * an OAuth token and as long as an app's token (`apps/token.ts`). A caller
 * may ask for anything from a minute to 30 days (OAuth's "month"), never
 * longer and never forever. Tokens do not mint tokens, and this account has
 * no password or passkey, so the agent uses the day to arrange how it keeps
 * working; when the token lapses the account cannot sign in.
 */
export const FIRST_ADMIN_TOKEN_TTL_S = LIFETIMES["day"]!;
export const FIRST_ADMIN_TOKEN_MIN_S = 60;
export const FIRST_ADMIN_TOKEN_MAX_S = LIFETIMES["month"]!;

/** The lifetime asked for (`expiresIn`, whole seconds), or undefined when it is not one we mint. */
export function firstAdminLifetime(asked: unknown): number | undefined {
  if (asked === undefined || asked === null) return FIRST_ADMIN_TOKEN_TTL_S;
  if (typeof asked !== "number" || !Number.isInteger(asked)) return undefined;
  if (asked < FIRST_ADMIN_TOKEN_MIN_S || asked > FIRST_ADMIN_TOKEN_MAX_S) return undefined;
  return asked;
}

const limiters = new WeakMap<App, RateLimiter>();

/**
 * Take one attempt from the budget: per address (`signin.per_account`, the
 * claim's budget) and for the whole forge (`signin.per_forge`). False when
 * either is spent.
 */
function attempt(app: App, address: string): boolean {
  let limiter = limiters.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: 0, adminPerMinute: 0, enabled: true });
    limiters.set(app, limiter);
  }
  limiter.setLimits({
    perMinute: limitValue(app.db, "signin.per_account"),
    adminPerMinute: limitValue(app.db, "signin.per_forge"),
    enabled: true,
  });
  return limiter.take(`address:${bucketOf(address)}`, "ro").allowed && limiter.take("forge", "admin").allowed;
}

/** What is wrong with a code, name and address, without taking an attempt. */
function problemOf(
  app: App,
  input: { code: string; username: string; email: string },
): FirstAdminError | undefined {
  if (readFirstAdmin(app.db, input.code) !== "ok") return "refused";
  if (!USERNAME.test(input.username)) return "invalid_username";
  if (getUserByName(app.db, input.username)) return "username_taken";
  if (!input.email.includes("@")) return "invalid_email";
  return undefined;
}

/** Whether a code, name and address are worth a passkey ceremony; one attempt, nothing spent. */
export function firstAdminProblem(
  app: App,
  input: { code: string; username: string; email: string; address: string },
): FirstAdminError | undefined {
  if (!attempt(app, input.address)) return "rate_limited";
  return problemOf(app, input);
}

/**
 * Spend the code and make the first admin. `finish` gives the account its
 * way in (a passkey, or a token) and says whether it could; when it cannot,
 * the account is undone and the code put back.
 */
export async function redeemFirstAdmin<T>(
  app: App,
  input: { code: string; username: string; email: string; via: "passkey" | "token"; address: string },
  finish: (user: User) => T | undefined,
): Promise<Result<{ user: User; finished: T }, FirstAdminError>> {
  if (!attempt(app, input.address)) return err("rate_limited");
  const problem = problemOf(app, input);
  if (problem !== undefined) return err(problem);
  // Spent first, in one statement: of two redemptions on one code, one wins.
  if (burnFirstAdmin(app.db, input.code) !== "ok") return err("refused");
  // Origin: the operator's first admin, an exemption from the signup policy
  // (the operator vouches by minting the code), as a claim is.
  const made = await createUser(app.db, {
    origin: "first-admin",
    username: input.username,
    email: input.email,
    isAdmin: true,
    // The operator's code is the proof, as the spawner's link is for a claim.
    trusted: true,
  });
  if (!made.ok) {
    unburnFirstAdmin(app.db, input.code);
    return err(
      made.error === "email_taken" || made.error === "username_reserved" || made.error === "username_taken"
        ? made.error
        : "invalid_username",
    );
  }
  const finished = finish(made.value);
  if (finished === undefined) {
    discardFreshUser(app.db, made.value.id);
    unburnFirstAdmin(app.db, input.code);
    return err("unfinished");
  }
  const spawned = await spawnedOrg(app);
  if (spawned !== undefined) handOver(app.db, spawned, made.value.id);
  app.bus.append({
    kind: "user.created",
    actorId: made.value.id,
    payload: { via: FIRST_ADMIN_ORIGIN, with: input.via, address: input.address },
  });
  app.log.info("first admin made", { user: made.value.username, with: input.via });
  return ok({ user: made.value, finished });
}

/**
 * Spend a recovery code (`core/first_admin.ts`) and give the stranded admin it
 * was minted for a new expiring token. The same budget as every other look at
 * a code, taken before it is read; no account is made. `expiresIn` is already
 * a lifetime `firstAdminLifetime` allows.
 */
export function recoverFirstAdmin(
  app: App,
  input: { code: string; scope: TokenScope; name: string; expiresIn: number; address: string },
  now = Date.now(),
): Result<{ user: User; id: string; token: string; expiresAt: string }, "rate_limited" | "refused"> {
  if (!attempt(app, input.address)) return err("rate_limited");
  const userId = burnFirstAdminRecovery(app.db, input.code, now);
  const user = userId === undefined ? undefined : getUserById(app.db, userId);
  if (user === undefined) return err("refused");
  const expiresAt = new Date(now + input.expiresIn * 1000).toISOString();
  const minted = createToken(app, user, input.name || "first-admin-recovery", input.scope, { expiresAt });
  if (!minted.ok) {
    unburnFirstAdmin(app.db, input.code);
    return err("refused");
  }
  app.bus.append({
    kind: "user.recovered",
    actorId: user.id,
    payload: {
      via: FIRST_ADMIN_RECOVERY,
      tokenId: minted.value.id,
      scope: input.scope,
      expiresAt,
      address: input.address,
    },
  });
  app.log.info("stranded admin recovered", { user: user.username });
  return ok({ user, ...minted.value, expiresAt });
}
