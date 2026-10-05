/**
 * Web sessions. The cookie carries a high-entropy secret; the database holds
 * only its hash — a leaked database never yields a usable session.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { secret } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { getUserById, isActive, type User } from "./users.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createSession(
  db: Database,
  userId: string,
): { token: string; expiresAt: Date } {
  const token = secret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.query(
    "INSERT INTO session (token_hash, user_id, expires_at) VALUES (?1, ?2, ?3)",
  ).run(sha256(token), userId, expiresAt.toISOString());
  return { token, expiresAt };
}

export function sessionUser(
  db: Database,
  token: string,
): Result<User, "invalid_session"> {
  const row = db
    .query<
      { user_id: string; expires_at: string },
      [string]
    >("SELECT user_id, expires_at FROM session WHERE token_hash = ?1")
    .get(sha256(token));
  if (!row || row.expires_at <= new Date().toISOString())
    return err("invalid_session");
  const user = getUserById(db, row.user_id);
  return user && isActive(user) ? ok(user) : err("invalid_session");
}

export function destroySession(db: Database, token: string): void {
  db.query("DELETE FROM session WHERE token_hash = ?1").run(sha256(token));
}

/** Housekeeping for the background worker. */
export function pruneSessions(db: Database): number {
  return db
    .query("DELETE FROM session WHERE expires_at <= ?1")
    .run(new Date().toISOString()).changes;
}
