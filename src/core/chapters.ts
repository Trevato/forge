/**
 * Chapters (#11603): a named list of a repository's issues that is finished, tagged and closed.
 * A repository has at most one open chapter and any number drafted after it. While one is open the
 * crew builds only what is in it; once the last is closed the crew rests until the owner opens the
 * next. A repository with no chapter is left alone: continuous flow, as before.
 *
 * Plain data in and out: the db, ids, a clock. The acts (who may, the tag, the events) are in
 * `actions/chapters.ts`; the closing words are in `core/chapter_notes.ts`.
 */

import type { Database } from "bun:sqlite";
import { releaseOfPull } from "../release/record.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { closesFromBody, getPull } from "./pulls.ts";
import type { Issue } from "./issues.ts";

export type ChapterState = "draft" | "open" | "closed";

export interface Chapter {
  readonly id: string;
  readonly repoId: string;
  readonly name: string;
  readonly means: string;
  readonly state: ChapterState;
  readonly position: number;
  readonly patchOf: string | null;
  readonly createdAt: string;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly tagOid: string | null;
  readonly notes: string;
  readonly costUsd: number | null;
}

interface Row {
  id: string;
  repo_id: string;
  name: string;
  means: string;
  state: ChapterState;
  position: number;
  patch_of: string | null;
  created_at: string;
  opened_at: string | null;
  closed_at: string | null;
  tag_oid: string | null;
  notes: string;
  cost_usd: number | null;
}

const toChapter = (r: Row): Chapter => ({
  id: r.id,
  repoId: r.repo_id,
  name: r.name,
  means: r.means,
  state: r.state,
  position: r.position,
  patchOf: r.patch_of,
  createdAt: r.created_at,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
  tagOid: r.tag_oid,
  notes: r.notes,
  costUsd: r.cost_usd,
});

/** A chapter's name is also its git tag: a short, plain ref name. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const MAX_MEANS = 300;

export type ChapterError = "invalid_name" | "means_too_long" | "exists" | "already_open" | "not_draft" | "closed" | "not_found";

export function listChapters(db: Database, repoId: string): Chapter[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM chapter WHERE repo_id = ?1
        ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, position, created_at`,
    )
    .all(repoId)
    .map(toChapter);
}

export function getChapter(db: Database, repoId: string, name: string): Chapter | undefined {
  const row = db.query<Row, [string, string]>("SELECT * FROM chapter WHERE repo_id = ?1 AND name = ?2").get(repoId, name);
  return row === null ? undefined : toChapter(row);
}

export function getChapterById(db: Database, chapterId: string): Chapter | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM chapter WHERE id = ?1").get(chapterId);
  return row === null ? undefined : toChapter(row);
}

/** The repository's open chapter, if it has one. */
export function openChapterOf(db: Database, repoId: string): Chapter | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM chapter WHERE repo_id = ?1 AND state = 'open'").get(repoId);
  return row === null ? undefined : toChapter(row);
}

/** The drafted chapter that comes next: the one first in line. */
export function nextChapterOf(db: Database, repoId: string): Chapter | undefined {
  const row = db
    .query<Row, [string]>("SELECT * FROM chapter WHERE repo_id = ?1 AND state = 'draft' ORDER BY position, created_at LIMIT 1")
    .get(repoId);
  return row === null ? undefined : toChapter(row);
}

/** Draft a chapter, last in line. A patch chapter names the closed one it fixes. */
export function draftChapter(
  db: Database,
  repoId: string,
  input: { name: string; means?: string; patchOf?: string },
  byId: string,
): Result<Chapter, ChapterError> {
  const name = input.name.trim();
  const means = (input.means ?? "").trim();
  if (!NAME.test(name) || name.endsWith(".") || name.includes("..")) return err("invalid_name");
  if (means.length > MAX_MEANS) return err("means_too_long");
  if (getChapter(db, repoId, name) !== undefined) return err("exists");
  const last = db
    .query<{ p: number | null }, [string]>("SELECT MAX(position) AS p FROM chapter WHERE repo_id = ?1")
    .get(repoId)?.p;
  const chapterId = id();
  db.query(
    `INSERT INTO chapter (id, repo_id, name, means, position, patch_of, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).run(chapterId, repoId, name, means, (last ?? 0) + 1, input.patchOf ?? null, byId);
  return ok(getChapterById(db, chapterId)!);
}

/** Open a drafted chapter: the repository's one open chapter, from now. */
export function startChapter(db: Database, chapter: Chapter, now: Date): Result<Chapter, ChapterError> {
  if (chapter.state === "closed") return err("closed");
  if (chapter.state === "open") return err("already_open");
  if (openChapterOf(db, chapter.repoId) !== undefined) return err("already_open");
  db.query("UPDATE chapter SET state = 'open', opened_at = ?2 WHERE id = ?1").run(chapter.id, now.toISOString());
  return ok(getChapterById(db, chapter.id)!);
}

/** The next name after `name`: v1.0.0 → v2.0.0. */
export function nextName(name: string): string {
  const m = /^(\D*)(\d+)(.*)$/.exec(name);
  if (m === null) return `${name}-next`;
  return `${m[1]}${Number(m[2]) + 1}${(m[3] ?? "").replace(/\d+/g, "0")}`;
}

/** A patch's name after `name`: v1.0.0 → v1.0.1; a name without three numbers gets `.1`. */
export function patchName(name: string): string {
  const m = /^(.*\d+\.\d+\.)(\d+)$/.exec(name);
  return m === null ? `${name}.1` : `${m[1]}${Number(m[2]) + 1}`;
}

// ---- items ----

/** The chapter an issue is in, if any. */
export function chapterOfIssue(db: Database, issueId: string): Chapter | undefined {
  const row = db
    .query<Row, [string]>("SELECT c.* FROM chapter c JOIN chapter_item i ON i.chapter_id = c.id WHERE i.issue_id = ?1")
    .get(issueId);
  return row === null ? undefined : toChapter(row);
}

/** Put an issue in a chapter (moving it from another that is not closed). Closed chapters hold their list. */
export function putIssue(db: Database, chapter: Chapter, issueId: string, byId: string | undefined): Result<void, ChapterError> {
  if (chapter.state === "closed") return err("closed");
  const from = chapterOfIssue(db, issueId);
  if (from?.state === "closed") return err("closed");
  db.query(
    `INSERT INTO chapter_item (issue_id, chapter_id, by_id) VALUES (?1, ?2, ?3)
     ON CONFLICT(issue_id) DO UPDATE SET chapter_id = ?2, by_id = ?3, at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(issueId, chapter.id, byId ?? null);
  return ok(undefined);
}

export function takeIssueOut(db: Database, chapter: Chapter, issueId: string): boolean {
  if (chapter.state === "closed") return false;
  return db.query("DELETE FROM chapter_item WHERE issue_id = ?1 AND chapter_id = ?2").run(issueId, chapter.id).changes > 0;
}

export type ItemStatus = "done" | "building" | "left";

export interface Item {
  readonly issueId: string;
  readonly number: number;
  readonly title: string;
  readonly status: ItemStatus;
  /** When it went live and proven; null until then. */
  readonly doneAt: string | null;
  /** The pull that shipped it, when one did. */
  readonly pull: number | null;
  readonly builder: string | null;
  readonly costUsd: number;
}

interface ItemRow {
  id: string;
  number: number;
  title: string;
  state: "open" | "closed";
}

interface PullFact {
  readonly id: string;
  readonly number: number;
  readonly mergedAt: string | null;
  readonly closes: readonly number[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Every pull of the repository with the issue numbers it closes, read once for the whole list: the
 * list's cost is one pass over the pulls however many items it holds, never a scan per item.
 */
function pullFacts(db: Database, repoId: string): PullFact[] {
  return db
    .query<{ id: string; number: number; body: string; at: string | null }, [string]>(
      `SELECT issue.id AS id, issue.number AS number, issue.body AS body, pull.merged_at AS at
         FROM pull JOIN issue ON issue.id = pull.issue_id WHERE issue.repo_id = ?1 AND issue.body LIKE '%#%'`,
    )
    .all(repoId)
    .map((r) => ({ id: r.id, number: r.number, mergedAt: r.at, closes: closesFromBody(r.body) }));
}

/** What each issue's own runs spent, by issue id: one grouped read for the repository. */
function runSpend(db: Database, repoId: string): Map<string, number> {
  const rows = db
    .query<{ id: string; usd: number }, [string]>(
      `SELECT run.issue_id AS id, COALESCE(SUM(run.cost_usd), 0) AS usd FROM run JOIN issue ON issue.id = run.issue_id
        WHERE issue.repo_id = ?1 GROUP BY run.issue_id`,
    )
    .all(repoId);
  return new Map(rows.map((r) => [r.id, r.usd]));
}

/**
 * Where an item stands. Done is live and proven: closed, shipped by a merged pull that production's
 * release proof passed for (`release.ok`), never merely merged.
 */
function statusOf(
  db: Database,
  repoId: string,
  row: ItemRow,
  closing: readonly PullFact[],
): Pick<Item, "status" | "doneAt" | "pull" | "builder"> {
  // Merged pulls that close it, newest first: any one of them may be the one production proved.
  const merged =
    row.state === "closed"
      ? closing
          .filter((f) => f.mergedAt !== null)
          .sort((a, b) => (a.mergedAt === b.mergedAt ? b.number - a.number : a.mergedAt! < b.mergedAt! ? 1 : -1))
      : [];
  const first = merged[0];
  for (const m of merged) {
    const proof = releaseOfPull(db, repoId, m.number);
    if (proof !== undefined) return { status: "done", doneAt: proof.createdAt, pull: m.number, builder: getPull(db, repoId, m.number)?.authorName ?? null };
  }
  const active =
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND state IN ('queued','running')")
      .get(row.id)?.n ?? 0;
  return { status: active > 0 || first !== undefined || row.state === "closed" ? "building" : "left", doneAt: null, pull: first?.number ?? null, builder: null };
}

/**
 * A closed chapter's list never changes (its items are held, its pulls have landed), so it is read
 * once and kept: a public page or API read of a closed chapter costs a lookup after the first.
 */
const FROZEN_MAX = 200;
const frozen = new Map<string, Item[]>();

/** Forget the kept lists: a test that rebuilds a database. */
export function forgetFrozenItems(): void {
  frozen.clear();
}

/** A chapter's list, in issue order, each item with where it stands and what it cost. */
export function itemsOf(db: Database, chapter: Chapter): Item[] {
  const kept = chapter.state === "closed" ? frozen.get(chapter.id) : undefined;
  if (kept !== undefined) return kept;
  const rows = db
    .query<ItemRow, [string]>(
      `SELECT i.id, i.number, i.title, i.state FROM chapter_item c JOIN issue i ON i.id = c.issue_id
        WHERE c.chapter_id = ?1`,
    )
    .all(chapter.id)
    .sort((a, b) => a.number - b.number);
  const out: Item[] = [];
  if (rows.length > 0) {
    const facts = pullFacts(db, chapter.repoId);
    const spend = runSpend(db, chapter.repoId);
    for (const r of rows) {
      const closing = facts.filter((f) => f.id !== r.id && f.closes.includes(r.number));
      const cost = round4((spend.get(r.id) ?? 0) + closing.reduce((sum, f) => sum + round4(spend.get(f.id) ?? 0), 0));
      out.push({ issueId: r.id, number: r.number, title: r.title, ...statusOf(db, chapter.repoId, r, closing), costUsd: cost });
    }
  }
  if (chapter.state === "closed") {
    if (frozen.size >= FROZEN_MAX) frozen.delete(frozen.keys().next().value!);
    frozen.set(chapter.id, out);
  }
  return out;
}

export interface Progress {
  readonly done: number;
  readonly total: number;
  /** When the list will be finished at the pace so far, or null before there is a pace. */
  readonly finishesOn: string | null;
}

/** Items done against the list, and the day it finishes at the pace since the chapter opened. */
export function progressOf(chapter: Chapter, items: readonly Item[], now: Date): Progress {
  const done = items.filter((i) => i.status === "done").length;
  const total = items.length;
  if (chapter.openedAt === null || done === 0 || done >= total) return { done, total, finishesOn: null };
  const days = Math.max((now.getTime() - Date.parse(chapter.openedAt)) / 86_400_000, 1 / 24);
  const left = (total - done) / (done / days);
  return { done, total, finishesOn: new Date(now.getTime() + left * 86_400_000).toISOString().slice(0, 10) };
}

// ---- the crew's gate ----

/** Whether the repository has closed a chapter and opened none since: the crew rests. */
export function resting(db: Database, repoId: string): boolean {
  return (
    openChapterOf(db, repoId) === undefined &&
    db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM chapter WHERE repo_id = ?1 AND state = 'closed'").get(repoId)!.n > 0
  );
}

/** The issue number a body says it is a defect of: "Defect of #12". */
export function defectOf(body: string): number | undefined {
  const m = /\bdefect (?:of|in|on) #(\d+)\b/i.exec(body);
  return m === null ? undefined : Number(m[1]);
}

/**
 * Why the crew may not start work on this issue now, or null when it may: a chapter is open and the
 * issue (or, for a pull, what it closes) is not in it, or the repository rests between chapters.
 * A repository with no chapter is never held.
 */
export function chapterHold(db: Database, repoId: string, issue: Pick<Issue, "id" | "kind" | "body">): string | null {
  const open = openChapterOf(db, repoId);
  if (open === undefined) return resting(db, repoId) ? "the repository rests between chapters; the owner opens the next" : null;
  const inOpen = (issueId: string): boolean => chapterOfIssue(db, issueId)?.id === open.id;
  if (inOpen(issue.id)) return null;
  if (issue.kind === "pull") {
    const closes = closesFromBody(issue.body);
    if (closes.length === 0) return null;
    for (const n of closes) {
      const target = db.query<{ id: string }, [string, number]>("SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2").get(repoId, n);
      if (target !== null && inOpen(target.id)) return null;
    }
  }
  return `outside ${open.name}: the crew builds only what the open chapter holds`;
}

/**
 * Where an issue the planner opens lands while a chapter is open: a defect of a chapter item joins the
 * chapter; anything else waits in the next chapter. Undefined when no chapter is open (nothing to do)
 * or no later chapter is drafted (the caller sends it to Later).
 */
export function placeNewIssue(db: Database, repoId: string, issueId: string, body: string): { chapter: Chapter; scope: "defect" | "next" } | "later" | undefined {
  const open = openChapterOf(db, repoId);
  if (open === undefined) return undefined;
  const n = defectOf(body);
  if (n !== undefined) {
    const parent = db.query<{ id: string }, [string, number]>("SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2").get(repoId, n);
    if (parent !== null && chapterOfIssue(db, parent.id)?.id === open.id) return { chapter: open, scope: "defect" };
  }
  const next = nextChapterOf(db, repoId);
  return next === undefined ? "later" : { chapter: next, scope: "next" };
}

/** Parts of a split issue stay in its chapter. */
export function inheritChapter(db: Database, parent: Issue, children: readonly Issue[], byId: string | undefined): void {
  const chapter = chapterOfIssue(db, parent.id);
  if (chapter === undefined || chapter.state === "closed") return;
  for (const child of children) putIssue(db, chapter, child.id, byId);
}
