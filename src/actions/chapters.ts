/**
 * The owner's acts on chapters (#11603): draft, open, fill, close the book, patch. One door for the
 * page and the API. Only a human admin of the repository acts (an agent never adds scope: the crew
 * proposes, a person decides); each change is an event, so the queue shows who moved what.
 * The rules are in `core/chapters.ts`, the notes' words in `core/chapter_notes.ts`.
 */

import type { App } from "../app.ts";
import { chapterNotes, daysBetween } from "../core/chapter_notes.ts";
import {
  draftChapter,
  getChapter,
  itemsOf,
  nextChapterOf,
  nextName,
  chapterOfIssue,
  openChapterOf,
  patchName,
  placeNewIssue,
  putIssue,
  startChapter,
  takeIssueOut,
  type Chapter,
  type Item,
  type ChapterError,
} from "../core/chapters.ts";
import { addDependency } from "../core/dependencies.ts";
import { getIssue, labelsFor, type Issue } from "../core/issues.ts";
import { laterGate } from "../crew/later.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type ChapterActError = ChapterError | "forbidden" | "no_issue" | "unfinished" | "no_branch" | "tag_exists" | "git";

/** A person who administers the repository, never an agent. */
function owner(app: App, actor: User | undefined, repo: Repo): actor is User {
  return actor !== undefined && actor.kind !== "agent" && canAdmin(app.db, repo, actor);
}

export function draft(app: App, actor: User | undefined, repo: Repo, input: { name: string; means?: string }): Result<Chapter, ChapterActError> {
  if (!owner(app, actor, repo)) return err("forbidden");
  const made = draftChapter(app.db, repo.id, input, actor.id);
  if (made.ok) app.bus.append({ kind: "chapter.drafted", repoId: repo.id, actorId: actor.id, payload: { name: made.value.name } });
  return made;
}

/** The checks `open` makes before it writes, shared with `preview` so the two cannot disagree. */
function openPlan(app: App, actor: User | undefined, repo: Repo, name: string): Result<{ actor: User; chapter: Chapter }, ChapterActError> {
  if (!owner(app, actor, repo)) return err("forbidden");
  const chapter = getChapter(app.db, repo.id, name);
  if (chapter === undefined) return err("not_found");
  if (chapter.state === "closed") return err("closed");
  if (chapter.state === "open" || openChapterOf(app.db, repo.id) !== undefined) return err("already_open");
  return ok({ actor, chapter });
}

export function open(app: App, actor: User | undefined, repo: Repo, name: string, now = new Date()): Result<Chapter, ChapterActError> {
  const planned = openPlan(app, actor, repo, name);
  if (!planned.ok) return planned;
  const started = startChapter(app.db, planned.value.chapter, now);
  if (started.ok) app.bus.append({ kind: "chapter.opened", repoId: repo.id, actorId: planned.value.actor.id, payload: { name } });
  return started;
}

/** The checks `fill` makes before it writes, shared with `preview`. */
function fillPlan(
  app: App,
  actor: User | undefined,
  repo: Repo,
  name: string,
  number: number,
  add: boolean,
): Result<{ actor: User; chapter: Chapter; issue: Issue }, ChapterActError> {
  if (!owner(app, actor, repo)) return err("forbidden");
  const chapter = getChapter(app.db, repo.id, name);
  if (chapter === undefined) return err("not_found");
  const issue = getIssue(app.db, repo.id, number);
  if (issue === undefined || issue.kind !== "issue") return err("no_issue");
  if (chapter.state === "closed") return err(add ? "closed" : "not_found");
  if (add) {
    if (chapterOfIssue(app.db, issue.id)?.state === "closed") return err("closed");
  } else if (!itemsOf(app.db, chapter).some((i) => i.number === issue.number)) return err("not_found");
  return ok({ actor, chapter, issue });
}

/** Add an issue to a chapter, or take it out (`add` false): the owner's act, recorded. */
export function fill(app: App, actor: User | undefined, repo: Repo, name: string, number: number, add: boolean): Result<void, ChapterActError> {
  const planned = fillPlan(app, actor, repo, name, number, add);
  if (!planned.ok) return planned;
  const { chapter, issue } = planned.value;
  const done: Result<void, ChapterActError> = add
    ? putIssue(app.db, chapter, issue.id, planned.value.actor.id)
    : takeIssueOut(app.db, chapter, issue.id)
      ? ok(undefined)
      : err("not_found");
  if (done.ok) app.bus.append({ kind: add ? "chapter.item_added" : "chapter.item_removed", repoId: repo.id, actorId: planned.value.actor.id, payload: { name, number } });
  return done;
}

/** What closing would do, found by the checks `close` makes before it writes anything. */
interface ClosePlan {
  readonly actor: User;
  readonly chapter: Chapter;
  readonly items: readonly Item[];
  readonly left: readonly Item[];
  readonly dir: string;
  readonly tip: string;
  readonly ref: string;
}

async function closePlan(app: App, actor: User | undefined, repo: Repo, name: string, ship: boolean): Promise<Result<ClosePlan, ChapterActError>> {
  if (!owner(app, actor, repo)) return err("forbidden");
  const chapter = getChapter(app.db, repo.id, name);
  if (chapter === undefined) return err("not_found");
  if (chapter.state === "closed") return err("closed");
  if (chapter.state !== "open") return err("not_draft");
  const items = itemsOf(app.db, chapter);
  const left = items.filter((i) => i.status !== "done");
  if (left.length > 0 && !ship) return err("unfinished");
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tipped = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${repo.defaultBranch}^{commit}`], { cwd: dir });
  if (!tipped.ok) return err("no_branch");
  const ref = `refs/tags/${chapter.name}`;
  if ((await runGit(["rev-parse", "--verify", "--quiet", ref], { cwd: dir })).ok) return err("tag_exists");
  return ok({ actor, chapter, items, left, dir, tip: tipped.value.trim(), ref });
}

/** What an act would do, said before it is done and changing nothing: the same refusals as the act itself. */
export async function preview(
  app: App,
  actor: User | undefined,
  repo: Repo,
  verb: "open" | "add" | "remove" | "close",
  name: string,
  number?: number,
): Promise<Result<{ says: string; tag?: string; moves?: { number: number; title: string }[]; into?: string }, ChapterActError>> {
  if (verb === "close") {
    const planned = await closePlan(app, actor, repo, name, true);
    if (!planned.ok) return planned;
    const { chapter, items, left, tip } = planned.value;
    const into = left.length === 0 ? undefined : (nextChapterOf(app.db, repo.id)?.name ?? nextName(chapter.name));
    const moves = left.map((i) => ({ number: i.number, title: i.title }));
    return ok({
      says:
        `Would close ${chapter.name}: tag ${chapter.name} at ${tip.slice(0, 12)} on ${repo.defaultBranch}, write the notes for ${items.length - left.length} done` +
        (into === undefined ? "." : `, and move ${left.length} unfinished to ${into}.`),
      tag: chapter.name,
      ...(into === undefined ? {} : { into, moves }),
    });
  }
  if (verb === "open") {
    const planned = openPlan(app, actor, repo, name);
    return planned.ok ? ok({ says: `Would open ${planned.value.chapter.name}.` }) : planned;
  }
  const planned = fillPlan(app, actor, repo, name, number ?? 0, verb === "add");
  if (!planned.ok) return planned;
  const { chapter, issue } = planned.value;
  return ok({ says: verb === "add" ? `Would add #${issue.number} to ${chapter.name}.` : `Would take #${issue.number} out of ${chapter.name}.` });
}

/**
 * Close the book: tag the default branch's tip with the chapter's name, write the notes from what
 * landed, move what is left (only with `ship`) to the next chapter and mark the chapter closed.
 * Nothing starts afterwards: with no chapter open the crew rests (`chapterHold`).
 */
export async function close(
  app: App,
  actor: User | undefined,
  repo: Repo,
  name: string,
  ship: boolean,
  now = new Date(),
): Promise<Result<Chapter, ChapterActError>> {
  const planned = await closePlan(app, actor, repo, name, ship);
  if (!planned.ok) return planned;
  const { actor: by, chapter, items, left, dir, tip, ref } = planned.value;
  if (!(await runGit(["update-ref", ref, tip, ""], { cwd: dir })).ok) return err("git");

  const closedAt = now.toISOString();
  const landed = items
    .filter((i) => i.status === "done")
    .map((item) => ({ item, fix: labelsFor(app.db, item.issueId).some((l) => l.name.toLowerCase() === "bug") }));
  const costUsd = Math.round(landed.reduce((s, l) => s + l.item.costUsd, 0) * 1e4) / 1e4;
  // The tag was created only if absent, so it is ours: whatever stops the book closing takes it back,
  // or a retry would answer `tag_exists` for good.
  let next: Chapter | undefined;
  try {
    app.db.transaction(() => {
      // What is left moves on to the next chapter, drafted when there is none.
      next = left.length === 0 ? undefined : nextChapterOf(app.db, repo.id);
      if (left.length > 0 && next === undefined) {
        const made = draftChapter(app.db, repo.id, { name: nextName(chapter.name) }, by.id);
        next = made.ok ? made.value : undefined;
      }
      const notes = chapterNotes(chapter.name, chapter.means, landed, left, next?.name, {
        opened: chapter.openedAt ?? closedAt,
        closed: closedAt,
        days: daysBetween(chapter.openedAt ?? closedAt, closedAt),
        doneCount: landed.length,
        costUsd,
      });
      if (next !== undefined) for (const i of left) putIssue(app.db, next, i.issueId, by.id);
      const closed = app.db
        .query("UPDATE chapter SET state = 'closed', closed_at = ?2, tag_oid = ?3, notes = ?4, cost_usd = ?5 WHERE id = ?1 AND state = 'open'")
        .run(chapter.id, closedAt, tip, notes, costUsd);
      if (closed.changes !== 1) throw new Error("chapter_not_open");
    }).immediate();
  } catch {
    await runGit(["update-ref", "-d", ref, tip], { cwd: dir });
    return err(getChapter(app.db, repo.id, name)?.state === "closed" ? "closed" : "git");
  }
  app.bus.append({ kind: "chapter.closed", repoId: repo.id, actorId: by.id, payload: { name, tag: chapter.name, shipped: landed.length, moved: left.length, ...(next === undefined ? {} : { into: next.name }) } });
  return ok(getChapter(app.db, repo.id, name)!);
}

/** Open a patch chapter for a closed one, with one click: drafted and opened together. */
export function patch(app: App, actor: User | undefined, repo: Repo, closedName: string, now = new Date()): Result<Chapter, ChapterActError> {
  if (!owner(app, actor, repo)) return err("forbidden");
  const closed = getChapter(app.db, repo.id, closedName);
  if (closed === undefined) return err("not_found");
  if (closed.state !== "closed") return err("not_draft");
  if (openChapterOf(app.db, repo.id) !== undefined) return err("already_open");
  let name = patchName(closed.name);
  while (getChapter(app.db, repo.id, name) !== undefined) name = patchName(name);
  const made = draftChapter(app.db, repo.id, { name, means: `Fixes for what ${closed.name} shipped.`, patchOf: closed.id }, actor.id);
  if (!made.ok) return made;
  const started = startChapter(app.db, made.value, now);
  if (started.ok) app.bus.append({ kind: "chapter.opened", repoId: repo.id, actorId: actor.id, payload: { name, patchOf: closed.name } });
  return started;
}

/**
 * A planner's new issue while a chapter is open: a defect of a chapter item joins the chapter; any
 * other waits in the next chapter, or, with none drafted, behind the Later gate where the owner
 * sees it queued. The planner never adds scope to the open chapter.
 */
export function keepWithinChapter(app: App, repo: Repo, issue: Issue, planner: User): void {
  const placed = placeNewIssue(app.db, repo.id, issue.id, issue.body);
  if (placed === undefined) return;
  if (placed === "later") {
    const gate = laterGate(app.db, repo.id);
    const gateIssue = gate === undefined ? undefined : getIssue(app.db, repo.id, gate);
    if (gateIssue !== undefined) addDependency(app.db, issue, gateIssue, planner.id);
    return;
  }
  putIssue(app.db, placed.chapter, issue.id, planner.id);
  app.bus.append({ kind: "chapter.item_added", repoId: repo.id, actorId: planner.id, payload: { name: placed.chapter.name, number: issue.number, scope: placed.scope } });
}

/** What each refusal says, in the words every door uses. */
export const CHAPTER_WORDS: Readonly<Record<ChapterActError, string>> = {
  invalid_name: "A chapter's name is letters, digits, dots, dashes and underscores, at most 40 (it becomes the git tag).",
  means_too_long: "What done means is one sentence, at most 300 characters.",
  exists: "A chapter with that name already exists.",
  already_open: "Another chapter is already open: a repository has one open chapter at a time.",
  not_draft: "That chapter is not open for this.",
  closed: "A closed chapter cannot be changed or reopened; open a patch chapter instead.",
  not_found: "No such chapter, or nothing to do.",
  forbidden: "Only a person who administers this repository opens, fills and closes chapters.",
  no_issue: "No such issue here.",
  unfinished: "Items are still open. Ship the chapter to move them to the next one and close the book.",
  no_branch: "The default branch has no commit to tag yet.",
  tag_exists: "A git tag with that name already exists.",
  git: "The tag could not be written.",
};
