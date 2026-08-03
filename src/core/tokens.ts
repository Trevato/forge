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
}

/** Returns the secret exactly once. It is never reconstructable. */
export function createToken(
  db: Database,
  userId: string,
  name: string,
  scope: TokenScope,
): { id: string; token: string } {
  const tokenId = id();
  const token = `forge_${secret()}`;
  db.query(
    "INSERT INTO token (id, token_hash, user_id, name, scope) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(tokenId, sha256(token), userId, name, scope);
  return { id: tokenId, token };
}

export function verifyToken(
  db: Database,
  presented: string,
): Result<{ user: User; scope: TokenScope }, "invalid_token"> {
  const row = db
    .query<
      { id: string; user_id: string; scope: TokenScope },
      [string]
    >("SELECT id, user_id, scope FROM token WHERE token_hash = ?1")
    .get(sha256(presented));
  if (!row) return err("invalid_token");
  const user = getUserById(db, row.user_id);
  if (!user) return err("invalid_token");
  db.query("UPDATE token SET last_used_at = ?1 WHERE id = ?2").run(
    new Date().toISOString(),
    row.id,
  );
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
      },
      [string]
    >("SELECT id, name, scope, created_at, last_used_at FROM token WHERE user_id = ?1 ORDER BY id")
    .all(userId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
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
