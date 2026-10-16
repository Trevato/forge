/**
 * Who may make an account: `open`, `invite` or `closed`. Stored in
 * `forge_setting` under `signup`, and every change is kept in
 * `forge_setting_change` (who, when, from what to what). Default `open`.
 * `/signup`, `POST /api/v1/users`, passkey signup and a first edge sign-in ask
 * it (`signupClosed` in `actions/users.ts`); `invite` acts as closed until #1143.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { writeSetting } from "./limits.ts";

export const SIGNUP_MODES = ["open", "invite", "closed"] as const;
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

/** Set the mode and keep the change; the same mode again keeps nothing. */
export function setSignup(db: Database, value: SignupMode, actorId: string): void {
  const from = getSignup(db);
  if (from === value) return;
  writeSetting(db, STORE_KEY, value, from, value, actorId);
}

/** `FORGE_SIGNUP` from the environment: unset is no opinion, a bad value is a message. */
export function signupFromEnv(raw: string | undefined): Result<SignupMode | null, string> {
  const s = (raw ?? "").trim();
  if (s === "") return ok(null);
  const parsed = parseSignup(s);
  return parsed.ok
    ? parsed
    : err(`FORGE_SIGNUP: open, invite or closed, not "${s.slice(0, 20)}"`);
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
      actorName: r.username ?? (r.actor_id === BOOT_ACTOR ? "FORGE_SIGNUP at boot" : ""),
      at: r.at,
    }));
}
