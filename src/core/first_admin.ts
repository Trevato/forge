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
 *
 * Recovery. A headless first admin holds only an expiring token, and tokens
 * do not mint tokens, so when it lapses the forge can be left with admins and
 * no way in. While no admin has a working credential (`adminCanSignIn`), the
 * same command mints a recovery code instead, bound to one stranded admin:
 * the same row, hash, 15 minutes and single spend, redeemed only at
 * `POST /api/v1/first-admin/recover` for a new expiring token for that
 * account. It makes no account, and it dies the moment any admin can sign in.
 * Each kind of code is refused at the other's door.
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
  /** A recovery code: the id of the stranded admin it is for. Absent on a first-admin code. */
  readonly r?: string;
}

/** Which door a code opens: making the first admin, or recovering a stranded one. */
export type FirstAdminKind = "create" | "recover";

/**
 * Whether any admin (a person or an agent, suspended or not) can still sign
 * in or act: a password, a passkey, a token that has not expired (or never
 * does), a live session, an SSH key, or sign-in with the parent forge. While
 * one can, nobody is stranded and no recovery code is minted or honoured.
 */
export function adminCanSignIn(db: Database, now = Date.now()): boolean {
  const at = new Date(now).toISOString();
  return (
    db
      .query(
        `SELECT 1 FROM user u WHERE u.is_admin = 1 AND (
           u.password_hash <> ''
           OR EXISTS (SELECT 1 FROM passkey p WHERE p.user_id = u.id)
           OR EXISTS (SELECT 1 FROM token t WHERE t.user_id = u.id AND (t.expires_at IS NULL OR t.expires_at > ?1))
           OR EXISTS (SELECT 1 FROM session s WHERE s.user_id = u.id AND s.expires_at > ?1)
           OR EXISTS (SELECT 1 FROM user_key k WHERE k.user_id = u.id)
           OR EXISTS (SELECT 1 FROM federated_identity f WHERE f.user_id = u.id)
         ) LIMIT 1`,
      )
      .get(at) !== null
  );
}

/** The admins a recovery code may be for: people, active, and (while nobody can sign in) all stranded. */
export function strandedAdmins(db: Database): { id: string; username: string }[] {
  return db
    .query<{ id: string; username: string }, []>(
      `SELECT id, username FROM user WHERE is_admin = 1 AND is_agent = 0 AND kind = 'user'
         AND suspended_at IS NULL AND removed_at IS NULL ORDER BY username`,
    )
    .all();
}

const isStranded = (db: Database, userId: string): boolean =>
  strandedAdmins(db).some((a) => a.id === userId);

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
  return store(db, undefined, now);
}

/**
 * Mint a recovery code for one stranded admin, replacing any earlier code.
 * Refused (undefined) while any admin can sign in, or when `userId` is not
 * an active person admin.
 */
export function mintFirstAdminRecovery(
  db: Database,
  userId: string,
  now = Date.now(),
): { code: string; expiresAt: string } | undefined {
  if (adminCanSignIn(db, now) || !isStranded(db, userId)) return undefined;
  return store(db, userId, now);
}

function store(db: Database, recover: string | undefined, now: number): { code: string; expiresAt: string } {
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const expiresAt = new Date(now + FIRST_ADMIN_TTL_MS).toISOString();
  const value: Stored = { h: sha256(code), e: expiresAt, u: null, ...(recover === undefined ? {} : { r: recover }) };
  db.query(
    `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(value), OPERATOR_ACTOR, new Date(now).toISOString());
  return { code, expiresAt };
}

function judge(
  db: Database,
  code: string,
  now: number,
  kind: FirstAdminKind,
): { ok: false } | { ok: true; raw: string; stored: Stored } {
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
  if (stored.u !== null || !(Date.parse(stored.e) > now)) return { ok: false };
  if (kind === "create" && (stored.r !== undefined || hasAdmin(db))) return { ok: false };
  if (kind === "recover" && (typeof stored.r !== "string" || adminCanSignIn(db, now) || !isStranded(db, stored.r)))
    return { ok: false };
  return { ok: true, raw: row.value, stored };
}

/** What a code is worth right now, without spending it. */
export function readFirstAdmin(
  db: Database,
  code: string,
  now = Date.now(),
  kind: FirstAdminKind = "create",
): FirstAdminState {
  return judge(db, code, now, kind).ok ? "ok" : "refused";
}

/**
 * Spend the code: "ok" for exactly one caller. The row is swapped only if it
 * is still the unused value just read, in one statement.
 */
export function burnFirstAdmin(
  db: Database,
  code: string,
  now = Date.now(),
  kind: FirstAdminKind = "create",
): FirstAdminState {
  const judged = judge(db, code, now, kind);
  if (!judged.ok) return "refused";
  const spent: Stored = { ...judged.stored, u: new Date(now).toISOString() };
  const swapped = db
    .query("UPDATE forge_setting SET value = ?1 WHERE key = ?2 AND value = ?3")
    .run(JSON.stringify(spent), KEY, judged.raw);
  return swapped.changes === 1 ? "ok" : "refused";
}

/** Spend a recovery code: the stranded admin's id for exactly one caller. */
export function burnFirstAdminRecovery(db: Database, code: string, now = Date.now()): string | undefined {
  const judged = judge(db, code, now, "recover");
  if (!judged.ok || burnFirstAdmin(db, code, now, "recover") !== "ok") return undefined;
  return judged.stored.r;
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
