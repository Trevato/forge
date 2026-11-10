/**
 * A note's fix has landed (#10564): the pull that closes a `from-app` issue
 * leaves one comment on it, in plain words, written from the pull's own
 * description. The forge button shows it with the note, which reads shipped
 * once the issue is closed (`actions/app_notes.ts`). Pure text plus one
 * idempotent write; both ways a merge closes an issue (`mergePull`, the box
 * pass) call `noteShipped`. The comment is found again by the `note_shipped`
 * row the forge stores with it, never by its words, and when the release is
 * cut `noteReleased` rewrites it to name that release.
 */
import type { Database } from "bun:sqlite";
import { addComment, type Comment, type Issue } from "../core/issues.ts";
import { fromAppIssues } from "../core/from_app.ts";
import type { Pull } from "../core/pulls.ts";
import { getPull } from "../core/pulls.ts";
import { releaseLabel, releaseOfPull, type Release } from "../release/record.ts";
import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";

const MAX = 600;
/** Starts every such comment; only for reading, never for finding one again. */
const LEAD = "Good news: this is fixed";

/** Lines of a description that say nothing to a sender: closings, code, headings' marks, links, attribution. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[^\n]*#\d[^\n]*$/gim, " ")
    .replace(/^[^\n\w]*generated (with|by)\b[^\n]*$/gim, " ")
    .replace(/^\s*co-authored-by:[^\n]*$/gim, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*>]|\d+\.)\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/#\d+/g, "")
    // A hash is named as one ("commit abc1234") or has digits and letters both; a word or a number is not.
    .replace(/\b(commit|sha|revision)\s+[0-9a-f]{7,40}\b/gi, "")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, "")
    .replace(/\(\s*[,;]?\s*\)/g, "")
    .replace(/\s+([.,;)])/g, "$1")
    .replace(/[ \t]+/g, " ");
}

/** What was wrong and what changed, from a pull's title and description: no hashes, no markup, short. */
export function plainSummary(title: string, body: string): string {
  const paras = plain(body)
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p !== "");
  // The description's opening carries what changed; the rest is process.
  let text = paras.slice(0, 2).join("\n\n");
  if (text === "") text = plain(title).replace(/\s+/g, " ").trim();
  if (text.length > MAX) text = `${text.slice(0, MAX - 3).replace(/\s+\S*$/, "")}...`;
  return text;
}

/** The comment's words. */
export function shippedWords(pull: Pull, release: string | undefined): string {
  const where = release === undefined ? "It ships in the next release" : `It shipped in ${release}`;
  return `${LEAD}. ${where}.\n\n${plainSummary(pull.title, pull.body)}`;
}

/** The comment the forge wrote for this issue, if it has. */
function told(db: Database, issueId: string): { commentId: string; pullNumber: number } | undefined {
  const row = db
    .query<{ comment_id: string; pull_number: number }, [string]>("SELECT comment_id, pull_number FROM note_shipped WHERE issue_id = ?1")
    .get(issueId);
  return row === null ? undefined : { commentId: row.comment_id, pullNumber: row.pull_number };
}

const wordsFor = (db: Database, pull: Pull, release: Release | undefined): string =>
  shippedWords(pull, release === undefined ? undefined : releaseLabel(release));

/**
 * Say a landed fix on `issue` once. Nothing when the issue is not a note from
 * an app, or the forge already wrote the comment. Returns the new comment.
 */
export function tellNoteShipped(db: Database, by: string, issue: Issue, pull: Pull): Comment | undefined {
  if (!fromAppIssues(db, [issue.id]).has(issue.id)) return undefined;
  if (told(db, issue.id) !== undefined) return undefined;
  const made = addComment(db, { issueId: issue.id, authorId: by, body: wordsFor(db, pull, releaseOfPull(db, pull.repoId, pull.number)) });
  if (!made.ok) return undefined;
  db.query("INSERT OR IGNORE INTO note_shipped (issue_id, comment_id, pull_number) VALUES (?1, ?2, ?3)").run(issue.id, made.value.id, pull.number);
  return made.value;
}

/** The one way a merge tells a note's sender: write the comment and announce it. */
export function noteShipped(app: App, by: string, repo: Repo, issue: Issue, pull: Pull): void {
  const said = tellNoteShipped(app.db, by, issue, getPull(app.db, repo.id, pull.number) ?? pull);
  if (said === undefined) return;
  app.bus.append({
    kind: "issue.commented",
    repoId: repo.id,
    actorId: by,
    payload: { number: issue.number, body: said.body, commentId: said.id },
  });
}

/** A release carrying `pull` was cut: its notes' comments now name it. Returns how many were rewritten. */
export function noteReleased(db: Database, release: Release): number {
  if (!release.ok || release.pullNumber === null) return 0;
  const pull = getPull(db, release.repoId, release.pullNumber);
  if (pull === undefined) return 0;
  const rows = db
    .query<{ comment_id: string }, [number, string]>(
      `SELECT s.comment_id FROM note_shipped s JOIN issue i ON i.id = s.issue_id WHERE s.pull_number = ?1 AND i.repo_id = ?2`,
    )
    .all(release.pullNumber, release.repoId);
  const body = wordsFor(db, pull, release);
  for (const r of rows) db.query("UPDATE comment SET body = ?1 WHERE id = ?2").run(body, r.comment_id);
  return rows.length;
}
