/**
 * Notes left from the forge button in an app (`apps/feedback.ts`): the row
 * that ties a sender to the issue their words became, so they can see it
 * move, and the owner's hides and bans. Pure data, no authz.
 */
import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

export interface AppNote {
  readonly id: string;
  readonly appId: string;
  readonly repoId: string;
  readonly issueNumber: number;
  readonly visitor: string;
  readonly name: string;
  readonly hidden: boolean;
  readonly createdAt: string;
}

interface Row {
  id: string;
  app_id: string;
  repo_id: string;
  issue_number: number;
  visitor: string;
  name: string;
  hidden: number;
  created_at: string;
}

const fromRow = (r: Row): AppNote => ({
  id: r.id,
  appId: r.app_id,
  repoId: r.repo_id,
  issueNumber: r.issue_number,
  visitor: r.visitor,
  name: r.name,
  hidden: r.hidden === 1,
  createdAt: r.created_at,
});

export function insertNote(
  db: Database,
  note: Pick<AppNote, "appId" | "repoId" | "issueNumber" | "visitor" | "name">,
): AppNote {
  const row: Row = {
    id: id(),
    app_id: note.appId,
    repo_id: note.repoId,
    issue_number: note.issueNumber,
    visitor: note.visitor,
    name: note.name,
    hidden: 0,
    created_at: new Date().toISOString(),
  };
  db.query(
    "INSERT INTO app_note (id, app_id, repo_id, issue_number, visitor, name, hidden, created_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7)",
  ).run(row.id, row.app_id, row.repo_id, row.issue_number, row.visitor, row.name, row.created_at);
  return fromRow(row);
}

/** A sender's notes, newest first, the hidden ones left out. */
export function notesOf(db: Database, appId: string, visitor: string, limit = 20): AppNote[] {
  return db
    .query<Row, [string, string, number]>(
      "SELECT * FROM app_note WHERE app_id = ?1 AND visitor = ?2 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT ?3",
    )
    .all(appId, visitor, limit)
    .map(fromRow);
}

/** Every sender's notes on an app, newest first: the owner's view. */
export function notesOfApp(db: Database, appId: string, limit = 50): AppNote[] {
  return db
    .query<Row, [string, number]>(
      "SELECT * FROM app_note WHERE app_id = ?1 AND hidden = 0 ORDER BY created_at DESC, id DESC LIMIT ?2",
    )
    .all(appId, limit)
    .map(fromRow);
}

export function getNote(db: Database, appId: string, noteId: string): AppNote | undefined {
  const row = db
    .query<Row, [string, string]>("SELECT * FROM app_note WHERE app_id = ?1 AND id = ?2")
    .get(appId, noteId);
  return row ? fromRow(row) : undefined;
}

export function hideNote(db: Database, noteId: string): void {
  db.query("UPDATE app_note SET hidden = 1 WHERE id = ?1").run(noteId);
}

/** Ban a sender: they are refused from now on and every note of theirs is hidden. */
export function banVisitor(db: Database, appId: string, visitor: string): void {
  db.query("INSERT OR IGNORE INTO app_note_ban (app_id, visitor, created_at) VALUES (?1,?2,?3)").run(
    appId,
    visitor,
    new Date().toISOString(),
  );
  db.query("UPDATE app_note SET hidden = 1 WHERE app_id = ?1 AND visitor = ?2").run(appId, visitor);
}

/** Let a banned sender write again; the notes hidden with the ban stay hidden. */
export function unbanVisitor(db: Database, appId: string, visitor: string): void {
  db.query("DELETE FROM app_note_ban WHERE app_id = ?1 AND visitor = ?2").run(appId, visitor);
}

/**
 * Each banned sender once, newest ban first, as their latest note (hidden or
 * not): the note's id is how the owner names them, never the visitor key.
 */
export function bannedNotes(db: Database, appId: string, limit = 50): AppNote[] {
  return db
    .query<Row, [string, number]>(
      `SELECT n.* FROM app_note_ban b
         JOIN app_note n ON n.app_id = b.app_id AND n.visitor = b.visitor
        WHERE b.app_id = ?1
          AND n.id = (SELECT m.id FROM app_note m WHERE m.app_id = b.app_id AND m.visitor = b.visitor
                      ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
        ORDER BY b.created_at DESC, n.id DESC LIMIT ?2`,
    )
    .all(appId, limit)
    .map(fromRow);
}

export function isBanned(db: Database, appId: string, visitor: string): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT 1 AS n FROM app_note_ban WHERE app_id = ?1 AND visitor = ?2",
      )
      .get(appId, visitor) !== null
  );
}

/** Say whose words an issue holds: its voice becomes the sender's, a reader's (`crew/direct.ts voiceOf`). */
export function markSender(db: Database, issueId: string, name: string): void {
  db.query("UPDATE issue SET origin_author = ?1 WHERE id = ?2").run(name, issueId);
}

/** Every visible note of a repository's apps, oldest first: what the planner reads. */
export function notesOfRepo(db: Database, repoId: string, limit = 200): AppNote[] {
  return db
    .query<Row, [string, number]>(
      "SELECT * FROM app_note WHERE repo_id = ?1 AND hidden = 0 ORDER BY created_at, id LIMIT ?2",
    )
    .all(repoId, limit)
    .map(fromRow);
}
