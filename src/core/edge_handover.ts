/**
 * The way back for a person the platform edge signed in, once the edge is
 * gone (#11802). An account the edge made has a noreply address, so email
 * recovery cannot reach it; an admin mints a way-back link for it and hands
 * it over, and opening it registers a passkey and signs the person in, the
 * same step a recovery link leads to (`/recover`).
 *
 * Only an account mapped to an edge login (`edge_link`) that has no way in
 * of its own — no password, no passkey, no parent link — gets one. One link
 * per account: minting again replaces it. The secret is stored only as its
 * hash, works once, and expires after `HANDOVER_TTL_MS`. Pure data: the
 * action decides who may mint (`actions/edge_handover.ts`).
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";

/** How long a way-back link works: a week, since it is handed over by a person, not mailed. */
export const HANDOVER_TTL_MS = 7 * 24 * 3_600_000;

const secret = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/** Mint (or replace) the account's way-back link; the plain secret, once. */
export function issueHandover(
  db: Database,
  userId: string,
  byId: string,
  now: number,
): string {
  const token = secret();
  db.query(
    `INSERT INTO edge_handover (user_id, token_hash, expires_at, by_id) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash,
       expires_at = excluded.expires_at, by_id = excluded.by_id,
       at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(userId, sha256(token), new Date(now + HANDOVER_TTL_MS).toISOString(), byId);
  return token;
}

/** Whose way-back link this is, if it still works; nothing is spent. */
export function handoverOwner(
  db: Database,
  token: string,
  now: number,
): string | undefined {
  if (token === "") return undefined;
  return (
    db
      .query<{ user_id: string }, [string, string]>(
        "SELECT user_id FROM edge_handover WHERE token_hash = ?1 AND expires_at > ?2",
      )
      .get(sha256(token), new Date(now).toISOString())?.user_id ?? undefined
  );
}

/** Spend a way-back link: the account it was for, once; undefined after. */
export function spendHandover(
  db: Database,
  token: string,
  now: number,
): string | undefined {
  if (token === "") return undefined;
  return (
    db
      .query<{ user_id: string }, [string, string]>(
        "DELETE FROM edge_handover WHERE token_hash = ?1 AND expires_at > ?2 RETURNING user_id",
      )
      .get(sha256(token), new Date(now).toISOString())?.user_id ?? undefined
  );
}
