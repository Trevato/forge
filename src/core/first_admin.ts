/**
 * The first-admin code: how the operator of a forge with no admin makes
 * one without a browser in the loop (`bun src/main.ts --first-admin`).
 *
 * Only someone who can run the forge's own code against its data directory
 * can mint one, so it is never reachable over the web: the operator's
 * terminal is the only place the code is ever shown. The forge keeps its
 * sha256, a deadline (15 minutes) and whether it was used, in one
 * `forge_setting` row; minting again replaces it, so only the newest code
 * works. It is spent by exactly one redemption, in the statement that
 * checks it, and is worth nothing once any person administers the forge —
 * minting is refused then too.
 *
 * Redeemed at `/first-admin` with a passkey (a person), or at
 * `POST /api/v1/first-admin` for a scoped token (a headless agent). Neither
 * door opens ordinary signup: `/signup` and `POST /api/v1/users` still take
 * a passkey and nothing else. Shaped like the spawn claim (`spawn/claim.ts`),
 * which a spawned child keeps; whichever makes the first admin first wins,
 * and the other is then refused as "owned".
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { hasAdmin } from "../spawn/claim.ts";

const KEY = "first_admin.code";
/** Who `forge_setting.updated_by` names for a code: the terminal, not an account. */
export const OPERATOR_ACTOR = "operator";
export const FIRST_ADMIN_TTL_MS = 15 * 60 * 1000;

interface Stored {
  /** sha256 of the code, hex. */
  readonly h: string;
  /** When it stops working, ISO. */
  readonly e: string;
  /** When it was used, ISO; null while it is unused. */
  readonly u: string | null;
}

/**
 * What a presented code is worth. One word for every refusal: the caller
 * says the same thing for each, so a guess learns nothing about which.
 */
export type FirstAdminState = "ok" | "refused";

/** The page a person opens: the code rides the fragment, which no request line, proxy log or Referer carries. */
export const firstAdminLink = (forgeUrl: string, code: string): string =>
  `${forgeUrl.replace(/\/+$/, "")}/first-admin#${code}`;

const CODE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mint a code, replacing any earlier one, and return it: the only copy.
 * Refused (undefined) when a person already administers the forge.
 */
export function mintFirstAdmin(db: Database, now = Date.now()): { code: string; expiresAt: string } | undefined {
  if (hasAdmin(db)) return undefined;
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = new Date(now + FIRST_ADMIN_TTL_MS).toISOString();
  const value: Stored = { h: sha256(code), e: expiresAt, u: null };
  db.query(
    `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(value), OPERATOR_ACTOR, new Date(now).toISOString());
  return { code, expiresAt };
}

function judge(db: Database, code: string, now: number): { ok: false } | { ok: true; raw: string; stored: Stored } {
  if (!CODE.test(code)) return { ok: false };
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
    .get(KEY);
  if (row === null) return { ok: false };
  let stored: Stored;
  try {
    stored = JSON.parse(row.value) as Stored;
  } catch {
    return { ok: false };
  }
  if (typeof stored.h !== "string" || stored.h !== sha256(code)) return { ok: false };
  if (stored.u !== null || !(Date.parse(stored.e) > now) || hasAdmin(db)) return { ok: false };
  return { ok: true, raw: row.value, stored };
}

/** What a code is worth right now, without spending it. */
export function readFirstAdmin(db: Database, code: string, now = Date.now()): FirstAdminState {
  return judge(db, code, now).ok ? "ok" : "refused";
}

/**
 * Spend the code: "ok" for exactly one caller. The row is swapped only if it
 * is still the unused value just read, in one statement.
 */
export function burnFirstAdmin(db: Database, code: string, now = Date.now()): FirstAdminState {
  const judged = judge(db, code, now);
  if (!judged.ok) return "refused";
  const spent: Stored = { ...judged.stored, u: new Date(now).toISOString() };
  const swapped = db
    .query("UPDATE forge_setting SET value = ?1 WHERE key = ?2 AND value = ?3")
    .run(JSON.stringify(spent), KEY, judged.raw);
  return swapped.changes === 1 ? "ok" : "refused";
}

/** Put a spent code back, when the account it was spent on could not be made. */
export function unburnFirstAdmin(db: Database, code: string): void {
  if (!CODE.test(code)) return;
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1")
    .get(KEY);
  if (row === null) return;
  let stored: Stored;
  try {
    stored = JSON.parse(row.value) as Stored;
  } catch {
    return;
  }
  if (stored.h !== sha256(code) || stored.u === null) return;
  db.query("UPDATE forge_setting SET value = ?1 WHERE key = ?2 AND value = ?3").run(
    JSON.stringify({ ...stored, u: null }),
    KEY,
    row.value,
  );
}
