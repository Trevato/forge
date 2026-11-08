/**
 * A person's conversations with the forge, stored turn by turn in the
 * database so they read back after a restart. A person has any number: each
 * has an id (its URL), a title they may change, and may be archived. Every
 * call takes the person's id and answers only for their own conversation;
 * another person's conversation is `not_found`. Plain data in, plain data out, no authz beyond
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
  readonly title: string;
  /** When it was put away; null while it is in the list. */
  readonly archivedAt: string | null;
}

/** Longest title kept, in characters; longer is refused, not cut. */
export const TITLE_MAX = 80;

export interface Turn {
  readonly id: string;
  readonly conversationId: string;
  readonly role: TurnRole;
  readonly text: string;
  readonly createdAt: string;
  /** Set aside by an edit, a regenerate or a retry: kept in history, no longer part of the conversation. */
  readonly replaced: boolean;
  /** The line saying a run could not answer; the page draws Retry beside it. */
  readonly failed: boolean;
}

interface ConversationRow {
  id: string;
  user_id: string;
  claude_session_id: string;
  created_at: string;
  updated_at: string;
  title: string;
  archived_at: string | null;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  role: TurnRole;
  text: string;
  created_at: string;
  replaced_at: string | null;
  failed: number;
}

const conversationOf = (r: ConversationRow): Conversation => ({
  id: r.id,
  userId: r.user_id,
  claudeSessionId: r.claude_session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  title: r.title,
  archivedAt: r.archived_at,
});

const turnOf = (r: TurnRow): Turn => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  text: r.text,
  createdAt: r.created_at,
  replaced: r.replaced_at !== null,
  failed: r.failed === 1,
});

/** Most conversations a person holds, archived ones included; past it, New is refused. */
export const CONVERSATIONS_MAX = 100;

/** What every door says when New is refused. */
export const TOO_MANY_WORDS = `you hold ${CONVERSATIONS_MAX} conversations, the most there can be; keep talking in one of them`;

/** Start a new conversation at a person's request: refused past `CONVERSATIONS_MAX`. */
export function createConversation(db: Database, userId: string): Result<Conversation, "too_many"> {
  return db.transaction((): Result<Conversation, "too_many"> => {
    const held = db.query("SELECT COUNT(*) AS n FROM conversation WHERE user_id = ?1").get(userId) as { n: number };
    return held.n >= CONVERSATIONS_MAX ? err("too_many") : ok(newConversation(db, userId));
  }).immediate();
}

/** Start a new, empty conversation. */
export function newConversation(db: Database, userId: string): Conversation {
  const now = new Date().toISOString();
  const row: ConversationRow = { id: id(), user_id: userId, claude_session_id: "", created_at: now, updated_at: now, title: "", archived_at: null };
  db.query(
    "INSERT INTO conversation (id, user_id, claude_session_id, created_at, updated_at) VALUES (?1,?2,'',?3,?3)",
  ).run(row.id, userId, now);
  return conversationOf(row);
}

/**
 * Where a message with no conversation named goes: the person's most recently
 * active conversation that is not archived, made on first use.
 */
export function openConversation(db: Database, userId: string): Conversation {
  const row = db
    .query("SELECT * FROM conversation WHERE user_id = ?1 AND archived_at IS NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1")
    .get(userId) as ConversationRow | null;
  return row === null ? newConversation(db, userId) : conversationOf(row);
}

/** One of the person's conversations by id; another person's is nothing. */
export function getConversation(db: Database, userId: string, conversationId: string): Conversation | undefined {
  const row = db
    .query("SELECT * FROM conversation WHERE id = ?1 AND user_id = ?2")
    .get(conversationId, userId) as ConversationRow | null;
  return row === null ? undefined : conversationOf(row);
}

/** The person's conversations, newest activity first; `archived` picks the put-away ones instead. */
export function listConversations(db: Database, userId: string, opts: { readonly archived?: boolean } = {}): Conversation[] {
  const rows = db
    .query(
      `SELECT * FROM conversation WHERE user_id = ?1 AND archived_at IS ${opts.archived === true ? "NOT" : ""} NULL ORDER BY updated_at DESC, rowid DESC LIMIT 200`,
    )
    .all(userId) as ConversationRow[];
  return rows.map(conversationOf);
}

/** Give a conversation a title (1 to `TITLE_MAX` characters, no line breaks); an empty one clears it. */
export function renameConversation(
  db: Database,
  userId: string,
  conversationId: string,
  title: string,
): Result<Conversation, "not_found" | "bad_title"> {
  const clean = title.trim();
  if (clean.length > TITLE_MAX || /[\u0000-\u001f\u007f]/.test(clean)) return err("bad_title");
  const changed = db.query("UPDATE conversation SET title = ?3 WHERE id = ?1 AND user_id = ?2").run(conversationId, userId, clean).changes;
  const found = changed === 0 ? undefined : getConversation(db, userId, conversationId);
  return found === undefined ? err("not_found") : ok(found);
}

/** Put a conversation away, or bring it back (`archived` false). It keeps its turns and its URL. */
export function archiveConversation(
  db: Database,
  userId: string,
  conversationId: string,
  archived: boolean,
): Result<Conversation, "not_found"> {
  const changed = db
    .query("UPDATE conversation SET archived_at = ?3 WHERE id = ?1 AND user_id = ?2")
    .run(conversationId, userId, archived ? new Date().toISOString() : null).changes;
  const found = changed === 0 ? undefined : getConversation(db, userId, conversationId);
  return found === undefined ? err("not_found") : ok(found);
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
  input: { readonly role: string; readonly text: string; readonly failed?: boolean },
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
    replaced_at: null,
    failed: input.failed === true ? 1 : 0,
  };
  db.query(
    "INSERT INTO conversation_turn (id, conversation_id, role, text, created_at, failed) VALUES (?1,?2,?3,?4,?5,?6)",
  ).run(row.id, row.conversation_id, row.role, row.text, row.created_at, row.failed);
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
 * Set aside the turn `fromId` and every turn after it that still stands: they
 * stay in history, marked replaced. Returns the ids set aside, so a refusal
 * can put them back (`restoreTurns`).
 */
export function setAsideFrom(db: Database, userId: string, conversationId: string, fromId: string): string[] {
  if (!owned(db, userId, conversationId)) return [];
  const now = new Date().toISOString();
  const rows = db
    .query(
      "UPDATE conversation_turn SET replaced_at = ?3 WHERE conversation_id = ?1 AND replaced_at IS NULL AND rowid >= (SELECT rowid FROM conversation_turn WHERE id = ?2 AND conversation_id = ?1) RETURNING id",
    )
    .all(conversationId, fromId, now) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Put back turns just set aside, as when the message that replaced them could not be answered. */
export function restoreTurns(db: Database, userId: string, conversationId: string, ids: readonly string[]): void {
  if (!owned(db, userId, conversationId)) return;
  for (const turnId of ids)
    db.query("UPDATE conversation_turn SET replaced_at = NULL WHERE id = ?1 AND conversation_id = ?2").run(turnId, conversationId);
}

/**
 * The person's last message that still stands and the turns after it, oldest
 * first; `person` is undefined when none stands. Edit, Regenerate and Retry
 * each look at this and at nothing older.
 */
export function lastExchange(db: Database, userId: string, conversationId: string): { person: Turn | undefined; after: Turn[] } {
  if (!owned(db, userId, conversationId)) return { person: undefined, after: [] };
  const row = db
    .query("SELECT rowid AS at, * FROM conversation_turn WHERE conversation_id = ?1 AND role = 'person' AND replaced_at IS NULL ORDER BY rowid DESC LIMIT 1")
    .get(conversationId) as (TurnRow & { at: number }) | null;
  if (row === null) return { person: undefined, after: [] };
  const after = db
    .query("SELECT * FROM conversation_turn WHERE conversation_id = ?1 AND replaced_at IS NULL AND rowid > ?2 ORDER BY rowid LIMIT ?3")
    .all(conversationId, row.at, MAX_PAGE) as TurnRow[];
  return { person: turnOf(row), after: after.map(turnOf) };
}

/** The person's conversation a via names, or their open one when it names none of theirs. */
export function conversationOfVia(db: Database, userId: string, via: string): Conversation {
  return getConversation(db, userId, via.slice("conversation:".length)) ?? openConversation(db, userId);
}

/**
 * What the agent last said to the person before the words `words`, when they
 * are the person's newest turn in the conversation the via names and that
 * message came straight before them. A reply written during the turn those
 * words started is after them, so the agent cannot make its own proposal.
 */
export function proposalBefore(db: Database, userId: string, via: string, words: string): string | undefined {
  const conversationId = via.slice("conversation:".length);
  if (!owned(db, userId, conversationId)) return undefined;
  const [newest, before] = db
    .query<{ role: TurnRole; text: string; failed: number }, [string]>(
      "SELECT role, text, failed FROM conversation_turn WHERE conversation_id = ?1 AND replaced_at IS NULL AND role IN ('person', 'agent') AND rowid <= (SELECT MAX(rowid) FROM conversation_turn WHERE conversation_id = ?1 AND role = 'person' AND replaced_at IS NULL) ORDER BY rowid DESC LIMIT 2",
    )
    .all(conversationId);
  if (newest === undefined || newest.text.trim() !== words.trim()) return undefined;
  return before?.role === "agent" && before.failed === 0 ? before.text : undefined;
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
