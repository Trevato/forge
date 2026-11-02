/**
 * A person's conversation with the forge: one per person, stored turn by turn
 * in the database so it reads back after a restart. Every call takes the
 * person's id and answers only for their own conversation; another person's
 * conversation is `not_found`. Plain data in, plain data out, no authz beyond
 * that ownership.
 */
import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const TURN_ROLES = ["person", "agent", "tool", "confirm"] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

/** Longest turn text kept, in characters; longer is refused, not cut. */
export const MAX_TURN_CHARS = 20_000;
/** Most turns a conversation keeps; each new turn past it pushes the oldest out. */
export const TURNS_KEPT = 1000;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

export interface Conversation {
  readonly id: string;
  readonly userId: string;
  readonly claudeSessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Turn {
  readonly id: string;
  readonly conversationId: string;
  readonly role: TurnRole;
  readonly text: string;
  readonly createdAt: string;
}

interface ConversationRow {
  id: string;
  user_id: string;
  claude_session_id: string;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  role: TurnRole;
  text: string;
  created_at: string;
}

const conversationOf = (r: ConversationRow): Conversation => ({
  id: r.id,
  userId: r.user_id,
  claudeSessionId: r.claude_session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const turnOf = (r: TurnRow): Turn => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  text: r.text,
  createdAt: r.created_at,
});

/** The person's conversation, made on first use. */
export function openConversation(db: Database, userId: string): Conversation {
  const now = new Date().toISOString();
  db.query(
    "INSERT OR IGNORE INTO conversation (id, user_id, claude_session_id, created_at, updated_at) VALUES (?1,?2,'',?3,?3)",
  ).run(id(), userId, now);
  const row = db
    .query("SELECT * FROM conversation WHERE user_id = ?1")
    .get(userId) as ConversationRow;
  return conversationOf(row);
}

const owned = (db: Database, userId: string, conversationId: string): boolean =>
  db
    .query("SELECT 1 FROM conversation WHERE id = ?1 AND user_id = ?2")
    .get(conversationId, userId) !== null;

/** Add a turn at the end. Text is 1 to `MAX_TURN_CHARS` characters. */
export function appendTurn(
  db: Database,
  userId: string,
  conversationId: string,
  input: { readonly role: string; readonly text: string },
): Result<Turn, "not_found" | "bad_role" | "empty_text" | "text_too_long"> {
  if (!owned(db, userId, conversationId)) return err("not_found");
  if (!(TURN_ROLES as readonly string[]).includes(input.role)) return err("bad_role");
  if (input.text.trim() === "") return err("empty_text");
  if (input.text.length > MAX_TURN_CHARS) return err("text_too_long");
  const now = new Date().toISOString();
  const row: TurnRow = {
    id: id(),
    conversation_id: conversationId,
    role: input.role as TurnRole,
    text: input.text,
    created_at: now,
  };
  db.query(
    "INSERT INTO conversation_turn (id, conversation_id, role, text, created_at) VALUES (?1,?2,?3,?4,?5)",
  ).run(row.id, row.conversation_id, row.role, row.text, row.created_at);
  db.query("UPDATE conversation SET updated_at = ?2 WHERE id = ?1").run(conversationId, now);
  db.query(
    "DELETE FROM conversation_turn WHERE conversation_id = ?1 AND rowid < (SELECT rowid FROM conversation_turn WHERE conversation_id = ?1 ORDER BY rowid DESC LIMIT 1 OFFSET ?2)",
  ).run(conversationId, TURNS_KEPT - 1);
  return ok(turnOf(row));
}

/** Take back a turn just added, as when the message it holds could not be answered. */
export function removeTurn(db: Database, userId: string, conversationId: string, turnId: string): void {
  if (!owned(db, userId, conversationId)) return;
  db.query("DELETE FROM conversation_turn WHERE id = ?1 AND conversation_id = ?2").run(turnId, conversationId);
}

/**
 * A page of turns, newest last: the latest `limit` turns, or the `limit`
 * before the turn id `before`, oldest first. Order is insertion order
 * (rowid), so turns written in the same millisecond keep their order. Page
 * back by passing the first turn's id as `before`.
 */
export function listTurns(
  db: Database,
  userId: string,
  conversationId: string,
  opts: { readonly before?: string; readonly limit?: number } = {},
): Result<Turn[], "not_found"> {
  if (!owned(db, userId, conversationId)) return err("not_found");
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(opts.limit ?? DEFAULT_PAGE)));
  const rows = db
    .query(
      "SELECT * FROM conversation_turn WHERE conversation_id = ?1 AND (?2 IS NULL OR rowid < (SELECT rowid FROM conversation_turn WHERE id = ?2 AND conversation_id = ?1)) ORDER BY rowid DESC LIMIT ?3",
    )
    .all(conversationId, opts.before ?? null, limit) as TurnRow[];
  return ok(rows.reverse().map(turnOf));
}

/**
 * The turns after the turn id `after`, oldest first, at most `MAX_PAGE`; an
 * empty `after` is the whole conversation's start, an id this conversation
 * does not have is nothing. The stream reads this to follow an answer being
 * written and to resume from the last turn a client saw.
 */
export function turnsAfter(db: Database, userId: string, conversationId: string, after: string): Turn[] {
  if (!owned(db, userId, conversationId)) return [];
  const rows = db
    .query(
      "SELECT * FROM conversation_turn WHERE conversation_id = ?1 AND rowid > COALESCE(CASE WHEN ?2 = '' THEN 0 ELSE (SELECT rowid FROM conversation_turn WHERE id = ?2 AND conversation_id = ?1) END, 9223372036854775807) ORDER BY rowid LIMIT ?3",
    )
    .all(conversationId, after, MAX_PAGE) as TurnRow[];
  return rows.map(turnOf);
}

/** What a Claude session id may look like: short, and only id characters. */
export const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Remember the Claude session this conversation resumes. */
export function setClaudeSession(
  db: Database,
  userId: string,
  conversationId: string,
  sessionId: string,
): Result<void, "not_found" | "bad_session"> {
  if (!SESSION_ID.test(sessionId)) return err("bad_session");
  const changed = db
    .query("UPDATE conversation SET claude_session_id = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2")
    .run(conversationId, userId, sessionId, new Date().toISOString()).changes;
  return changed === 0 ? err("not_found") : ok();
}
