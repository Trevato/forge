/**
 * The optional picture of a page that comes with a note from the forge
 * button (#4820): PNG or JPEG only, judged by its first bytes and never by
 * what the sender called it, at most `PICTURE_MAX` bytes, kept as a file
 * under the data directory. Pure data, no authz: who may see it is the
 * issue's readers, decided where it is served.
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PICTURE_MAX = 2 * 1024 * 1024;

export type PictureKind = "png" | "jpeg";
export const PICTURE_TYPE: Record<PictureKind, string> = { png: "image/png", jpeg: "image/jpeg" };

/** What the bytes are, from their signature: `undefined` for anything but PNG or JPEG. */
export function sniffPicture(bytes: Uint8Array): PictureKind | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > png.length && png.every((b, i) => bytes[i] === b)) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return undefined;
}

const dirOf = (dataDir: string): string => join(dataDir, "note-pictures");
// The note id is ours (a generated id), but the path never trusts that.
const safe = (noteId: string): boolean => /^[0-9a-z]{10,40}$/.test(noteId);

/** Keep a note's picture; false when it already has one or the id is odd. */
export function savePicture(
  db: Database,
  dataDir: string,
  note: { id: string; repoId: string; issueNumber: number },
  kind: PictureKind,
  bytes: Uint8Array,
): boolean {
  if (!safe(note.id) || bytes.length > PICTURE_MAX) return false;
  if (db.query("SELECT 1 FROM app_note_picture WHERE note_id = ?1").get(note.id) !== null) return false;
  // The file first: a failed write leaves no row, so the sender can try again.
  const file = join(dirOf(dataDir), `${note.id}.${kind}`);
  mkdirSync(dirOf(dataDir), { recursive: true });
  writeFileSync(file, bytes);
  const taken = db
    .query("INSERT OR IGNORE INTO app_note_picture (note_id, repo_id, issue_number, kind, bytes, created_at) VALUES (?1,?2,?3,?4,?5,?6)")
    .run(note.id, note.repoId, note.issueNumber, kind, bytes.length, new Date().toISOString());
  if (taken.changes === 0) {
    rmSync(file, { force: true });
    return false;
  }
  return true;
}

/** Take down the pictures of notes the owner hid or banned: the row and the file. */
export function dropHiddenPictures(db: Database, dataDir: string): void {
  const rows = db
    .query<{ note_id: string; kind: string }, []>(
      "SELECT p.note_id, p.kind FROM app_note_picture p JOIN app_note n ON n.id = p.note_id WHERE n.hidden = 1",
    )
    .all();
  for (const r of rows) {
    if (safe(r.note_id) && (r.kind === "png" || r.kind === "jpeg")) rmSync(join(dirOf(dataDir), `${r.note_id}.${r.kind}`), { force: true });
    db.query("DELETE FROM app_note_picture WHERE note_id = ?1").run(r.note_id);
  }
}

export interface Picture {
  readonly noteId: string;
  readonly kind: PictureKind;
  readonly bytes: Uint8Array;
}

/** The picture sent with an issue's note, if any. */
export function pictureOfIssue(db: Database, dataDir: string, repoId: string, issueNumber: number): Picture | undefined {
  const row = db
    .query<{ note_id: string; kind: string }, [string, number]>(
      "SELECT p.note_id, p.kind FROM app_note_picture p JOIN app_note n ON n.id = p.note_id WHERE p.repo_id = ?1 AND p.issue_number = ?2 AND n.hidden = 0 LIMIT 1",
    )
    .get(repoId, issueNumber);
  if (row === null || (row.kind !== "png" && row.kind !== "jpeg") || !safe(row.note_id)) return undefined;
  try {
    return { noteId: row.note_id, kind: row.kind, bytes: readFileSync(join(dirOf(dataDir), `${row.note_id}.${row.kind}`)) };
  } catch {
    return undefined;
  }
}

/** Whether an issue has a picture, without reading it. */
export function hasPicture(db: Database, repoId: string, issueNumber: number): boolean {
  return db
      .query("SELECT 1 FROM app_note_picture p JOIN app_note n ON n.id = p.note_id WHERE p.repo_id = ?1 AND p.issue_number = ?2 AND n.hidden = 0")
      .get(repoId, issueNumber) !== null;
}
