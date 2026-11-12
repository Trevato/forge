/**
 * Web sessions. The cookie carries a high-entropy secret; the database holds
 * only its hash — a leaked database never yields a usable session.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id as newId, secret } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { getUserById, isActive, type User } from "./users.ts";
import { quietly } from "./write_clock.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How stale a session's last-seen time may get before a request moves it. */
const SEEN_EVERY_MS = 60 * 1000;

/** A signed-in browser, as its person sees it: never its secret. */
export interface SessionInfo {
  readonly id: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly expiresAt: string;
  /** Where it was first seen from, when that was recorded. */
  readonly address: string | null;
  /** The browser asking: signing it out signs the asker out. */
  readonly current: boolean;
}

export function createSession(
  db: Database,
  userId: string,
): { token: string; expiresAt: Date } {
  const token = secret();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  db.query(
    "INSERT INTO session (token_hash, user_id, expires_at, id) VALUES (?1, ?2, ?3, ?4)",
  ).run(sha256(token), userId, expiresAt.toISOString(), newId());
  return { token, expiresAt };
}

export function sessionUser(
  db: Database,
  token: string,
): Result<User, "invalid_session"> {
  const found = sessionOf(db, token);
  return found.ok ? ok(found.value.user) : found;
}

/** The account behind a session cookie, and which of its browsers it is. */
export function sessionOf(
  db: Database,
  token: string,
  address?: string,
): Result<{ user: User; id: string; notice: boolean }, "invalid_session"> {
  const hash = sha256(token);
  const row = db
    .query<
      {
        id: string;
        user_id: string;
        expires_at: string;
        last_seen_at: string | null;
        notice: number;
      },
      [string]
    >(
      `SELECT id, user_id, expires_at, last_seen_at,
              EXISTS (SELECT 1 FROM account_notice n WHERE n.user_id = session.user_id AND n.seen_at IS NULL) AS notice
       FROM session WHERE token_hash = ?1`,
    )
    .get(hash);
  const now = new Date();
  if (!row || row.expires_at <= now.toISOString())
    return err("invalid_session");
  const user = getUserById(db, row.user_id);
  if (!user || !isActive(user)) return err("invalid_session");
  // At most one write a minute per browser, however busy it is.
  const stale = new Date(now.getTime() - SEEN_EVERY_MS).toISOString();
  if (row.last_seen_at === null || row.last_seen_at < stale)
    quietly(db, () =>
      db
        .query(
          "UPDATE session SET last_seen_at = ?1, address = COALESCE(address, ?3) WHERE token_hash = ?2",
        )
        .run(now.toISOString(), hash, address === undefined || address === "unknown" ? null : address),
    );
  return ok({ user, id: row.id, notice: row.notice === 1 });
}

export function destroySession(db: Database, token: string): void {
  db.query("DELETE FROM session WHERE token_hash = ?1").run(sha256(token));
}

/**
 * An account's signed-in browsers, newest first; `current` is the cookie
 * of the browser asking, when it is one of them.
 */
export function listSessions(
  db: Database,
  userId: string,
  current?: string,
): SessionInfo[] {
  const mine = current === undefined ? undefined : sha256(current);
  return db
    .query<
      {
        id: string;
        token_hash: string;
        created_at: string;
        last_seen_at: string | null;
        expires_at: string;
        address: string | null;
      },
      [string, string]
    >(
      `SELECT id, token_hash, created_at, last_seen_at, expires_at, address FROM session
       WHERE user_id = ?1 AND expires_at > ?2 ORDER BY created_at DESC, id`,
    )
    .all(userId, new Date().toISOString())
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      address: r.address,
      current: r.token_hash === mine,
    }));
}

/** Sign one browser of this account out. False when it is not theirs. */
export function endSession(db: Database, userId: string, id: string): boolean {
  return (
    db
      .query("DELETE FROM session WHERE id = ?1 AND user_id = ?2")
      .run(id, userId).changes > 0
  );
}

/** Housekeeping for the background worker. */
export function pruneSessions(db: Database): number {
  return db
    .query("DELETE FROM session WHERE expires_at <= ?1")
    .run(new Date().toISOString()).changes;
}
