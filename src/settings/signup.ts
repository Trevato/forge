/**
 * Who may make an account: `open`, `request`, `invite` or `closed`. Stored in
 * `forge_setting` under `signup`, and every change is kept in
 * `forge_setting_change` (who, when, from what to what). Default `open` when nothing is stored; a new forge stores `invite` (`seedSignup`).
 * `/signup`, `POST /api/v1/users`, passkey signup and a first edge sign-in ask
 * it (`signupClosed` in `actions/users.ts`); `invite` lets in only a person with
 * an open invite link (`core/invites.ts`), spent with the account.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { writeSetting } from "./limits.ts";

export const SIGNUP_MODES = ["open", "request", "invite", "closed"] as const;

/** What each mode means, in one line: shown beside the setting and read by the MCP. */
export const SIGNUP_MEANS: Record<SignupMode, string> = {
  open: "anyone can make an account and starts at once, under small limits",
  request: "anyone can ask for an account; it waits until an admin allows it",
  invite: "only a person with an invite link can make an account",
  closed: "no new accounts",
};
export type SignupMode = (typeof SIGNUP_MODES)[number];
export const SIGNUP_DEFAULT: SignupMode = "open";

/** The actor kept for a change made by `FORGE_SIGNUP` at boot. */
export const BOOT_ACTOR = "boot";

const STORE_KEY = "signup";

/** A mode from untrusted input: exactly one of the three, nothing else. */
export function parseSignup(raw: unknown): Result<SignupMode, "invalid_signup"> {
  return typeof raw === "string" && (SIGNUP_MODES as readonly string[]).includes(raw)
    ? ok(raw as SignupMode)
    : err("invalid_signup");
}

export function getSignup(db: Database): SignupMode {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
    .get(STORE_KEY);
  if (row === null) return SIGNUP_DEFAULT;
  const parsed = parseSignup(row.value);
  return parsed.ok ? parsed.value : SIGNUP_DEFAULT;
}

/** The mode last read or written per database: the header asks on every anonymous page, and only the writers below change it. */
const known = new WeakMap<Database, SignupMode>();

/** `getSignup` without a query once known; every write here forgets it. */
export function signupModeKnown(db: Database): SignupMode {
  let mode = known.get(db);
  if (mode === undefined) {
    mode = getSignup(db);
    known.set(db, mode);
  }
  return mode;
}

/** The actor kept for the value a new forge starts with. */
export const FRESH_ACTOR = "fresh";

/**
 * What a new forge starts with: `invite`, stored so it is the forge's own
 * value from then on. Only a forge that made its database just now is new
 * (`fresh`); one that stored a value keeps it, and one that never stored any
 * keeps the `open` it has always read as. A spawned child is a fresh data
 * directory, so it starts here too.
 */
export function seedSignup(db: Database, fresh: boolean): void {
  if (!fresh) return;
  const stored = db.query("SELECT 1 FROM forge_setting WHERE key = ?1").get(STORE_KEY);
  known.delete(db);
  if (stored === null) writeSetting(db, STORE_KEY, "invite", SIGNUP_DEFAULT, "invite", FRESH_ACTOR);
}

/** Set the mode and keep the change; the same mode again keeps nothing. */
export function setSignup(db: Database, value: SignupMode, actorId: string): void {
  const from = getSignup(db);
  if (from === value) return;
  writeSetting(db, STORE_KEY, value, from, value, actorId);
  known.delete(db);
}

/** `FORGE_SIGNUP` from the environment: unset is no opinion, a bad value is a message. */
export function signupFromEnv(raw: string | undefined): Result<SignupMode | null, string> {
  const s = (raw ?? "").trim();
  if (s === "") return ok(null);
  const parsed = parseSignup(s);
  return parsed.ok
    ? parsed
    : err(`FORGE_SIGNUP: open, request, invite or closed, not "${s.slice(0, 20)}"`);
}

export interface SignupChange {
  readonly from: string;
  readonly to: string;
  readonly actorName: string;
  readonly at: string;
}

/** The most recent changes, newest first. */
export function signupChanges(db: Database, limit = 20): SignupChange[] {
  return db
    .query<
      { from_value: string; to_value: string; username: string | null; actor_id: string; at: string },
      []
    >(
      `SELECT c.from_value, c.to_value, u.username, c.actor_id, c.at
         FROM forge_setting_change c LEFT JOIN user u ON u.id = c.actor_id
        WHERE c.key = 'signup'
        ORDER BY c.at DESC, c.rowid DESC
        LIMIT ${Math.trunc(limit)}`,
    )
    .all()
    .map((r) => ({
      from: r.from_value,
      to: r.to_value,
      actorName:
        r.username ??
        (r.actor_id === BOOT_ACTOR ? "FORGE_SIGNUP at boot" : r.actor_id === FRESH_ACTOR ? "new forge" : ""),
      at: r.at,
    }));
}
