/**
 * Whether an account's email is proven, and the one-time links that prove
 * it. Pure data: the actions send the mail and decide what an unproven
 * account may not do (`actions/verify.ts`).
 *
 * Fail closed: an account without a proven row is unproven. \`createUser\`
 * writes an unproven row for every person unless its caller vouches for the
 * address (\`trusted\`: a seeded admin, a claim, a fixture), and the
 * migration that made this table proved every account that already
 * existed. An agent is never held back (no mail reaches it), nor an
 * organization, which cannot sign in. A link's secret is stored only as its
 * hash, works once, and expires.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";

/** How long a link works. */
export const LINK_TTL_MS = 24 * 3_600_000;
/** How soon another link may be sent to the same account. */
export const RESEND_AFTER_MS = 5 * 60_000;

const secret = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export function emailVerified(db: Database, userId: string): boolean {
  const row = db
    .query<
      {
        kind: string;
        is_agent: number;
        verified_at: string | null;
      },
      [string]
    >(
      `SELECT u.kind, u.is_agent, c.verified_at
       FROM user u LEFT JOIN email_check c ON c.user_id = u.id WHERE u.id = ?1`,
    )
    .get(userId);
  if (row === null) return false;
  if (row.is_agent === 1 || row.kind === "org") return true;
  return row.verified_at !== null;
}

/** A new account's row: unproven until a link is followed or an owner says so. */
export function markUnproven(db: Database, userId: string): void {
  db.query("INSERT OR IGNORE INTO email_check (user_id) VALUES (?1)").run(userId);
}

/** Mark proven without a link: the forge's first account, an owner's word. */
export function markVerified(db: Database, userId: string, at: string): void {
  db.query(
    `INSERT INTO email_check (user_id, verified_at) VALUES (?1, ?2)
     ON CONFLICT(user_id) DO UPDATE SET verified_at = excluded.verified_at,
       token_hash = NULL, expires_at = NULL`,
  ).run(userId, at);
}

/** A new address is unproven again; any link to the old one stops working. */
export function resetVerification(db: Database, userId: string): void {
  db.query(
    `INSERT INTO email_check (user_id) VALUES (?1)
     ON CONFLICT(user_id) DO UPDATE SET verified_at = NULL,
       token_hash = NULL, expires_at = NULL`,
  ).run(userId);
}

/** The most links one account may be sent in a UTC day, whatever the address. */
export const SENDS_PER_DAY = 10;

/**
 * Mint a link to `to` for the account: the secret is returned once, its hash
 * kept. Undefined inside the resend window for the same address, or past the
 * day's cap — so changing the address cannot turn the forge into a way to
 * mail strangers.
 */
export function issueLink(
  db: Database,
  userId: string,
  to: string,
  now: number,
): string | undefined {
  const row = db
    .query<
      { last_sent_at: string | null; sent_to: string | null; sends_day: string | null; sends: number },
      [string]
    >("SELECT last_sent_at, sent_to, sends_day, sends FROM email_check WHERE user_id = ?1")
    .get(userId);
  const day = new Date(now).toISOString().slice(0, 10);
  const sends = row?.sends_day === day ? row.sends : 0;
  if (sends >= SENDS_PER_DAY) return undefined;
  const last = row?.last_sent_at ? Date.parse(row.last_sent_at) : 0;
  if (row?.sent_to?.toLowerCase() === to.toLowerCase() && now - last < RESEND_AFTER_MS)
    return undefined;
  const token = secret();
  db.query(
    `INSERT INTO email_check (user_id, token_hash, expires_at, last_sent_at, sent_to, sends_day, sends)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash,
       expires_at = excluded.expires_at, last_sent_at = excluded.last_sent_at,
       sent_to = excluded.sent_to, sends_day = excluded.sends_day, sends = excluded.sends`,
  ).run(
    userId,
    sha256(token),
    new Date(now + LINK_TTL_MS).toISOString(),
    new Date(now).toISOString(),
    to,
    day,
    sends + 1,
  );
  return token;
}

/** Follow a link: the account it proves, once, while it is fresh. */
export function consumeLink(
  db: Database,
  token: string,
  now: number,
): string | undefined {
  if (token === "") return undefined;
  const row = db
    .query<
      { user_id: string; expires_at: string | null },
      [string]
    >("SELECT user_id, expires_at FROM email_check WHERE token_hash = ?1 AND verified_at IS NULL")
    .get(sha256(token));
  if (row === null || row.expires_at === null) return undefined;
  if (Date.parse(row.expires_at) <= now) return undefined;
  markVerified(db, row.user_id, new Date(now).toISOString());
  return row.user_id;
}

/** How long a recovery link works. */
export const RECOVERY_TTL_MS = 30 * 60_000;

/**
 * Mint a recovery link for an account whose email is proven: the same
 * `email_check` slot a verification link uses, so there is one token store.
 * A proven account holds no verification link, so nothing is overwritten.
 * Undefined for an account that is not proven.
 */
export function issueRecovery(
  db: Database,
  userId: string,
  now: number,
): string | undefined {
  const token = secret();
  const changed = db
    .query(
      `UPDATE email_check SET token_hash = ?2, expires_at = ?3
       WHERE user_id = ?1 AND verified_at IS NOT NULL`,
    )
    .run(userId, sha256(token), new Date(now + RECOVERY_TTL_MS).toISOString());
  return changed.changes > 0 ? token : undefined;
}

/**
 * Whose recovery link this is, without spending it. Only a proven account's
 * link counts, so a pending verification link opens nothing here.
 */
export function recoveryOwner(
  db: Database,
  token: string,
  now: number,
): string | undefined {
  if (token === "") return undefined;
  return (
    db
      .query<{ user_id: string }, [string, string]>(
        `SELECT user_id FROM email_check
         WHERE token_hash = ?1 AND verified_at IS NOT NULL AND expires_at > ?2`,
      )
      .get(sha256(token), new Date(now).toISOString())?.user_id ?? undefined
  );
}

/** Spend a recovery link: the account it was for, once; undefined after. */
export function spendRecovery(
  db: Database,
  token: string,
  now: number,
): string | undefined {
  if (token === "") return undefined;
  return (
    db
      .query<{ user_id: string }, [string, string]>(
        `UPDATE email_check SET token_hash = NULL, expires_at = NULL
         WHERE token_hash = ?1 AND verified_at IS NOT NULL AND expires_at > ?2
         RETURNING user_id`,
      )
      .get(sha256(token), new Date(now).toISOString())?.user_id ?? undefined
  );
}
