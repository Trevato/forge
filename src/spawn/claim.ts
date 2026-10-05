/**
 * The claim link: how a spawned child forge is handed to the person it was
 * made for. The spawner sees the link once; the child keeps only its
 * sha256, a deadline (24 hours) and whether it was used. Whoever opens it
 * first and makes an account becomes the child's admin and an owner of its
 * organisation, and the link is burnt in the same statement that checks it,
 * so two people racing on one link cannot both win.
 *
 * It lives in `user_setting` on the child's organisation, one row: a
 * single-use secret that a fresh child needs exactly once, with no schema
 * change for every child to replay. Losing the row costs a new link from
 * the spawner, never access.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";

const KEY = "spawn_claim";
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

interface Stored {
  /** sha256 of the token, hex. */
  readonly h: string;
  /** When it stops working, ISO. */
  readonly e: string;
  /** When it was used, ISO; null while it is unused. */
  readonly u: string | null;
}

export type ClaimState =
  | { readonly state: "ok"; readonly orgId: string }
  | { readonly state: "used" | "expired" | "unknown" };

/** 32 random bytes, base64url: the only copy of the secret. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mint the child's claim link for `orgId`, replacing any earlier one, and
 * return the token. Called by spawn on the child's database.
 */
export function mintClaim(
  db: Database,
  orgId: string,
  now = Date.now(),
): string {
  const token = newToken();
  const value: Stored = {
    h: sha256(token),
    e: new Date(now + CLAIM_TTL_MS).toISOString(),
    u: null,
  };
  db.query(
    `INSERT INTO user_setting (user_id, key, value) VALUES (?1, ?2, ?3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(orgId, KEY, JSON.stringify(value));
  return token;
}

function find(
  db: Database,
  token: string,
): { orgId: string; raw: string; stored: Stored } | undefined {
  if (!TOKEN.test(token)) return undefined;
  const hash = sha256(token);
  const rows = db
    .query<
      { user_id: string; value: string },
      [string]
    >("SELECT user_id, value FROM user_setting WHERE key = ?1")
    .all(KEY);
  for (const row of rows) {
    let stored: Stored;
    try {
      stored = JSON.parse(row.value) as Stored;
    } catch {
      continue;
    }
    if (stored.h === hash)
      return { orgId: row.user_id, raw: row.value, stored };
  }
  return undefined;
}

/** What a token is worth right now, without spending it. */
export function readClaim(
  db: Database,
  token: string,
  now = Date.now(),
): ClaimState {
  const found = find(db, token);
  if (found === undefined) return { state: "unknown" };
  if (found.stored.u !== null) return { state: "used" };
  if (Date.parse(found.stored.e) <= now) return { state: "expired" };
  return { state: "ok", orgId: found.orgId };
}

/**
 * Spend the token: true for exactly one caller. The row is swapped only if
 * it is still the unused value just read, in one statement.
 */
export function burnClaim(
  db: Database,
  token: string,
  now = Date.now(),
): ClaimState {
  const found = find(db, token);
  if (found === undefined) return { state: "unknown" };
  if (found.stored.u !== null) return { state: "used" };
  if (Date.parse(found.stored.e) <= now) return { state: "expired" };
  const spent: Stored = { ...found.stored, u: new Date(now).toISOString() };
  const swapped = db
    .query(
      "UPDATE user_setting SET value = ?1 WHERE user_id = ?2 AND key = ?3 AND value = ?4",
    )
    .run(JSON.stringify(spent), found.orgId, KEY, found.raw);
  return swapped.changes === 1
    ? { state: "ok", orgId: found.orgId }
    : { state: "used" };
}

/** Put a spent token back, when the account it was spent on could not be made. */
export function unburnClaim(db: Database, token: string): void {
  const found = find(db, token);
  if (found === undefined || found.stored.u === null) return;
  const back: Stored = { ...found.stored, u: null };
  db.query(
    "UPDATE user_setting SET value = ?1 WHERE user_id = ?2 AND key = ?3 AND value = ?4",
  ).run(JSON.stringify(back), found.orgId, KEY, found.raw);
}
