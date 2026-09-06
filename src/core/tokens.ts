/**
 * Personal access tokens — the credential for git-over-HTTP and the API.
 * The secret is shown once at creation; the database holds only its hash.
 * Scopes are deliberately coarse in v1: ro < rw < admin.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id, secret } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { getUserById, type User } from "./users.ts";

export type TokenScope = "ro" | "rw" | "admin";

const rank: Record<TokenScope, number> = { ro: 0, rw: 1, admin: 2 };

export function scopeAllows(held: TokenScope, needed: TokenScope): boolean {
  return rank[held] >= rank[needed];
}

export interface TokenInfo {
  readonly id: string;
  readonly name: string;
  readonly scope: TokenScope;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  /** When the token stops working, or null for a token that does not. */
  readonly expiresAt: string | null;
}

/**
 * Returns the secret exactly once. It is never reconstructable. A token with
 * `expiresAt` is refused after that instant and swept away afterwards — the
 * credential an agent run gets, which must not outlive the run.
 */
export function createToken(
  db: Database,
  userId: string,
  name: string,
  scope: TokenScope,
  options: { expiresAt?: string } = {},
): { id: string; token: string } {
  const tokenId = id();
  const token = `forge_${secret()}`;
  db.query(
    "INSERT INTO token (id, token_hash, user_id, name, scope, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(tokenId, sha256(token), userId, name, scope, options.expiresAt ?? null);
  return { id: tokenId, token };
}

/**
 * How stale `last_used_at` is allowed to get.
 *
 * Recording it on every request turns every *read* into a write: an agent
 * fleet polling the API commits one transaction per request for a timestamp
 * whose only reader is a human glancing at a settings page. At two hundred
 * agents that is the busiest write in the forge, and it is bookkeeping.
 *
 * A minute of resolution answers the only question anyone asks of this field
 * — "is this token still in use?" — and turns those writes into one per
 * token per minute.
 */
const TOUCH_EVERY_MS = 60_000;

export function verifyToken(
  db: Database,
  presented: string,
): Result<{ user: User; scope: TokenScope }, "invalid_token"> {
  const row = db
    .query<
      {
        id: string;
        user_id: string;
        scope: TokenScope;
        last_used_at: string | null;
        expires_at: string | null;
      },
      [string]
    >(
      "SELECT id, user_id, scope, last_used_at, expires_at FROM token WHERE token_hash = ?1",
    )
    .get(sha256(presented));
  if (!row) return err("invalid_token");
  // Expiry is decided here, on every use, not by the sweep: a sweep that
  // runs late must not be a token that works late.
  if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now())
    return err("invalid_token");
  const user = getUserById(db, row.user_id);
  if (!user) return err("invalid_token");
  const now = Date.now();
  const seen =
    row.last_used_at === null ? 0 : Date.parse(row.last_used_at) || 0;
  if (now - seen >= TOUCH_EVERY_MS) {
    db.query("UPDATE token SET last_used_at = ?1 WHERE id = ?2").run(
      new Date(now).toISOString(),
      row.id,
    );
  }
  return ok({ user, scope: row.scope });
}

export function listTokens(db: Database, userId: string): TokenInfo[] {
  const rows = db
    .query<
      {
        id: string;
        name: string;
        scope: TokenScope;
        created_at: string;
        last_used_at: string | null;
        expires_at: string | null;
      },
      [string]
    >(
      "SELECT id, name, scope, created_at, last_used_at, expires_at FROM token WHERE user_id = ?1 ORDER BY id",
    )
    .all(userId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }));
}

/** Remove tokens past their expiry. A cheap DELETE, run on the worker tick. */
export function pruneTokens(db: Database, now: Date = new Date()): number {
  return db
    .query(
      "DELETE FROM token WHERE expires_at IS NOT NULL AND expires_at <= ?1",
    )
    .run(now.toISOString()).changes;
}

export function deleteToken(
  db: Database,
  userId: string,
  tokenId: string,
): boolean {
  return (
    db
      .query("DELETE FROM token WHERE id = ?1 AND user_id = ?2")
      .run(tokenId, userId).changes > 0
  );
}
