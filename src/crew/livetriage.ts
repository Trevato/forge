/**
 * Live triage (#3242). Two rules, no run, no spend.
 *
 * Filing (#3266): an open issue an hour old that serves no pillar gets one —
 * the pillar its title, else its body, names. One that names no pillar is
 * left as it is: nothing is held for lacking a pillar (#7791). The note
 * stays on a filed issue, so it is not done twice. Directions, umbrellas
 * and the gate itself are left alone, and a repository with no pillars has
 * nothing to file under.
 *
 * Closing: an issue the crew found already done on
 * the base branch stops waiting for a person to close it. Rules only, no
 * run, no spend. Only the crew's own note (`ALREADY_NOTE`, read through
 * `alreadyDone`) with every commit it names reachable from the default
 * branch closes anything; one commit that is not there leaves the issue
 * open. A second pass over the same state changes nothing, because a closed
 * issue is no longer a candidate.
 *
 * Second rule (#3268): a question is not a task. An open issue a person who
 * can write here opened, whose title starts `Question:`, `Wish:` or `Idea:`
 * or ends in `?`, becomes one `Folded: #N <title>` line on the direction
 * issue and closes as dropped, with a comment that says how to reopen it as
 * a task. Anyone else's issue, and an imported one, is never folded. A
 * folded issue that a person reopens stays open: the comment is the mark.
 *
 * The close is `setIssueState`, whose state change is committed before the
 * event is published; the counters here move only after it returns, so a
 * change that rolled back is neither counted nor announced.
 */

import type { App } from "../app.ts";
import { linkIssue } from "../actions/dependencies.ts";
import { addComment, setIssueState } from "../actions/issues.ts";
import { alreadyDone, CLOSED_NOTE, DONE_LIKE, reopenedByPerson } from "../core/done_on_main.ts";
import { getIssueById, getIssuesByIds, type Issue } from "../core/issues.ts";
import { addDependency, removeDependency } from "../core/dependencies.ts";
import { isStructural, pillarsOf, servedBy, type Pillar, type Pillars } from "../core/pillars.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { repoDir } from "../git/repos.ts";
import { isMirror } from "../origins/write-through.ts";
import { createLog } from "../kernel/log.ts";
import { onBase } from "./already.ts";

const log = createLog("livetriage");

/** The most changes one repository gets in one tick. */
export const MOST_CHANGES = 25;

/** What a pass did. */
export interface Triaged {
  closed: number;
  folded: number;
  /** Issues given the pillar they name. */
  labelled: number;
  /** Open issues over an hour old that name a pillar and that triage has yet to file. */
  missed: number;
}

export const none = (): Triaged => ({ closed: 0, folded: 0, labelled: 0, missed: 0 });

/** How old an issue is before triage files it. */
export const FILE_AFTER_MS = 60 * 60 * 1000;

/** The start of the one-line comment a filing leaves. */
export const FILED_NOTE = "Live triage (automatic, not written by a person):";

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether `text` names this pillar by its short form (`P0`) or its whole
 * label (`P0 Trust`). A bare name is not enough: names are common words.
 */
function names(text: string, pillar: Pillar): boolean {
  for (const word of [pillar.short, pillar.name])
    if (new RegExp(`(?<![\\w])${escapeRe(word)}(?![\\w])`, "i").test(text)) return true;
  return false;
}

/** The pillar the title names, else the body; the first in order wins. */
export function namedPillar(set: Pillars, issue: Issue): Pillar | undefined {
  return (
    set.pillars.find((p) => names(issue.title, p)) ??
    set.pillars.find((p) => names(issue.body, p))
  );
}

/** Ids of the repository's issues triage has already filed once. */
function filedIds(app: App, repo: Repo): Set<string> {
  return new Set(
    app.db
      .query<{ id: string }, [string, string]>(
        `SELECT DISTINCT c.issue_id AS id FROM comment c
           JOIN issue i ON i.id = c.issue_id
          WHERE i.repo_id = ?1 AND c.body LIKE ?2`,
      )
      .all(repo.id, `${FILED_NOTE}%`)
      .map((r) => r.id),
  );
}

/**
 * Open issues old enough to file that serve nothing yet and that triage has
 * not filed before, oldest first. One a person took back out stays out.
 */
function unfiled(app: App, repo: Repo, set: Pillars, now: Date): Issue[] {
  const before = new Date(now.getTime() - FILE_AFTER_MS).toISOString();
  const ids = app.db
    .query<{ id: string }, [string, string, string | null]>(
      `SELECT i.id AS id FROM issue i
        WHERE i.repo_id = ?1 AND i.kind = 'issue' AND i.state = 'open'
          AND i.created_at <= ?2 AND (?3 IS NULL OR i.id != ?3)
        ORDER BY i.number`,
    )
    .all(repo.id, before, repo.directionIssueId);
  if (ids.length === 0) return [];
  const served = servedBy(app.db, set);
  const filed = filedIds(app, repo);
  return [...getIssuesByIds(app.db, ids.map((r) => r.id)).values()]
    .filter((i) => !served.has(i.id) && !isStructural(set, i.id) && !filed.has(i.id))
    .sort((a, b) => a.number - b.number);
}

/**
 * File old, unplaced issues that name a pillar; returns how many were, and how
 * many that name one were left for the next tick by the cap. The link comes first: if the note then fails the issue is still
 * placed, which is the part that matters, and the failure is logged.
 */
function file(app: App, repo: Repo, by: User, now: Date): [number, number] {
  const set = pillarsOf(app.db, repo);
  if (set.pillars.length === 0) return [0, 0];
  const todo = unfiled(app, repo, set, now).flatMap((issue) => {
    const pillar = namedPillar(set, issue);
    return pillar === undefined ? [] : [{ issue, pillar }];
  });
  let filed = 0;
  for (const { issue, pillar } of todo) {
    if (filed >= MOST_CHANGES) break;
    try {
      const linked = linkIssue(app, by, repo, pillar.umbrella, issue);
      if (!linked.ok) continue;
      filed++;
      addComment(app, by, repo, issue, `${FILED_NOTE} filed under ${pillar.name}, which it names.`);
    } catch (error) {
      log.error("filing failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        issue: issue.number,
        error: String(error),
      });
    }
  }
  return [filed, todo.length - filed];
}

/** What the tick line says of a pass: `triageMiss` only when something was missed. */
export function tickFields(did: Triaged): Record<string, number> {
  return {
    triaged: did.closed,
    folded: did.folded,
    labelled: did.labelled,
    ...(did.missed === 0 ? {} : { triageMiss: did.missed }),
  };
}

/** What the comment on a folded issue starts with. */
export const FOLDED_NOTE = "Folded into the direction issue";

/** A title that asks or wishes rather than names work. */
export const isQuestion = (title: string): boolean =>
  /^\s*(question|wish|idea):/i.test(title) || /\?\s*$/.test(title);

/**
 * Open questions by people who can write here, oldest first. One carrying
 * the triage user's own folded note was folded once and reopened by a
 * person: that reopen stands. Matched on author and exact prefix, so no
 * one else's comment can block a fold and `_` or `%` are not wildcards.
 */
function questions(app: App, repo: Repo, by: User, directionId: string): Issue[] {
  const rows = app.db
    .query<{ id: string }, [string, string, string, string]>(
      `SELECT i.id AS id FROM issue i
        WHERE i.repo_id = ?1 AND i.kind = 'issue' AND i.state = 'open' AND i.id != ?2
          AND i.origin_author IS NULL
          AND NOT EXISTS (SELECT 1 FROM comment c WHERE c.issue_id = i.id
                           AND c.author_id = ?3
                           AND substr(c.body, 1, length(?4)) = ?4)
        ORDER BY i.number`,
    )
    .all(repo.id, directionId, by.id, FOLDED_NOTE);
  const out: Issue[] = [];
  for (const { id } of rows) {
    const issue = getIssueById(app.db, id);
    if (!issue || !isQuestion(issue.title)) continue;
    const author = getUserById(app.db, issue.authorId);
    if (author?.kind === "user" && canWrite(app.db, repo, author)) out.push(issue);
  }
  return out;
}

/**
 * Fold the questions into the direction issue. Each write commits and
 * announces on its own, in an order a partial failure leaves true: the line
 * (written once, found again by its exact text), then the close, then the
 * note that marks the fold done. A close that fails leaves a line that is
 * true and an issue the next tick folds without a second line.
 */
function fold(app: App, repo: Repo, by: User, did: Triaged): void {
  if (repo.directionIssueId === null) return;
  const direction = getIssueById(app.db, repo.directionIssueId);
  if (!direction || direction.state !== "open") return;
  for (const issue of questions(app, repo, by, direction.id)) {
    if (did.closed + did.folded >= MOST_CHANGES) break;
    try {
      const line = `Folded: #${issue.number} ${issue.title}`;
      const there = app.db
        .query<{ n: number }, [string, string, string]>(
          `SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND author_id = ?2 AND body = ?3`,
        )
        .get(direction.id, by.id, line)!.n;
      if (there === 0) {
        const added = addComment(app, by, repo, direction, line);
        if (!added.ok) throw new Error(String(added.error));
      }
      const closed = setIssueState(app, by, repo, issue, "closed", { reason: "dropped", triage: true });
      if (!closed.ok || closed.value.state !== "closed") throw new Error("not closed");
      did.folded++;
      const note = addComment(
        app,
        by,
        repo,
        issue,
        `${FOLDED_NOTE} (#${direction.number}) as a question, not a task. ` +
          "To work it, reopen this issue and retitle it as the task it asks for.",
      );
      if (!note.ok) throw new Error(String(note.error));
    } catch (error) {
      log.error("fold failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        issue: issue.number,
        error: String(error),
      });
    }
  }
}

/**
 * Open issues that carry an already-done note, oldest first. One that
 * already has a close note was closed once and reopened by a person: that
 * reopen stands, so it is not closed again.
 */
function candidates(app: App, repo: Repo): string[] {
  return app.db
    .query<{ id: string }, [string]>(
      `SELECT i.id AS id FROM issue i
        WHERE i.repo_id = ?1 AND i.kind = 'issue' AND i.state = 'open'
          AND EXISTS (SELECT 1 FROM comment n WHERE n.issue_id = i.id
                       AND n.body LIKE '${DONE_LIKE}')
          AND NOT EXISTS (SELECT 1 FROM comment c WHERE c.issue_id = i.id
                           AND c.body LIKE '${CLOSED_NOTE}%')
        ORDER BY i.number`,
    )
    .all(repo.id)
    .map((r) => r.id);
}

/** The comment a folded duplicate carries; `#N` is the survivor. */
export const DUPLICATE_NOTE = "duplicate of #";

/** A title as the fold compares it: case and punctuation do not count. */
export function sameTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Open issues whose titles match an older open one, as [loser, survivor].
 * The newer closes into the older, except that a person's newer issue is
 * never closed into a crew member's: then the older closes into it. A loser
 * the triage already folded once (a person reopened it) stays open, and the
 * plan's own issues are neither folded nor chosen as survivor. The note is
 * matched exactly and by the triage's author, so a person's comment that
 * merely starts the same way does not count.
 */
function duplicates(app: App, repo: Repo, by: User): Array<[Issue, Issue]> {
  const plan = pillarsOf(app.db, repo);
  const rows = app.db
    .query<{ id: string; title: string; agent: number; folded: number }, [string, string]>(
      `SELECT i.id AS id, i.title AS title, u.is_agent AS agent,
              EXISTS (SELECT 1 FROM comment c WHERE c.issue_id = i.id
                       AND c.author_id = ?2
                       AND c.body GLOB '${DUPLICATE_NOTE}[0-9]*'
                       AND substr(c.body, ${DUPLICATE_NOTE.length + 1}) NOT GLOB '*[^0-9]*') AS folded
         FROM issue i JOIN user u ON u.id = i.author_id
        WHERE i.repo_id = ?1 AND i.kind = 'issue' AND i.state = 'open'
        ORDER BY i.number`,
    )
    .all(repo.id, by.id);
  type Entry = { id: string; agent: boolean; folded: boolean };
  const first = new Map<string, Entry>();
  const pairs: Array<[string, string]> = [];
  for (const r of rows) {
    if (isStructural(plan, r.id)) continue;
    const key = sameTitle(r.title);
    if (key === "") continue;
    const older = first.get(key);
    const mine: Entry = { id: r.id, agent: r.agent === 1, folded: r.folded === 1 };
    if (older === undefined) {
      first.set(key, mine);
    } else if (!mine.agent && older.agent) {
      first.set(key, mine);
      if (!older.folded) pairs.push([older.id, mine.id]);
    } else if (!mine.folded) pairs.push([mine.id, older.id]);
  }
  const out: Array<[Issue, Issue]> = [];
  for (const [a, b] of pairs) {
    const loser = getIssueById(app.db, a);
    const survivor = getIssueById(app.db, b);
    if (loser && survivor) out.push([loser, survivor]);
  }
  return out;
}

/**
 * Whatever waited on the folded issue waits on the survivor. A link that
 * would close a loop is kept as it was, so no dependency is dropped silently.
 */
function moveDependents(app: App, loser: Issue, survivor: Issue, actorId: string) {
  const waiting = app.db
    .query<{ issue_id: string }, [string]>(
      "SELECT issue_id FROM issue_dependency WHERE blocked_by_id = ?1",
    )
    .all(loser.id);
  for (const w of waiting) {
    const issue = getIssueById(app.db, w.issue_id);
    if (!issue) continue;
    if (issue.id === survivor.id || addDependency(app.db, issue, survivor, actorId).ok)
      removeDependency(app.db, issue.id, loser.id);
  }
  // What the folded issue waited on, the survivor now waits on too.
  const blockers = app.db
    .query<{ blocked_by_id: string }, [string]>(
      "SELECT blocked_by_id FROM issue_dependency WHERE issue_id = ?1",
    )
    .all(loser.id);
  for (const b of blockers) {
    const blocker = getIssueById(app.db, b.blocked_by_id);
    if (blocker && blocker.id !== survivor.id) addDependency(app.db, survivor, blocker, actorId);
  }
}

/** Fold repeated titles; returns how many issues closed. */
function foldDuplicates(app: App, repo: Repo, by: User, room: number): number {
  let closed = 0;
  for (const [loser, survivor] of duplicates(app, repo, by)) {
    if (closed >= room) break;
    try {
      const done = setIssueState(app, by, repo, loser, "closed", {
        reason: "dropped",
        triage: true,
      });
      if (!done.ok || done.value.state !== "closed") continue;
      closed++;
      addComment(app, by, repo, loser, `${DUPLICATE_NOTE}${survivor.number}`);
      moveDependents(app, loser, survivor, by.id);
    } catch (error) {
      log.error("fold failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        issue: loser.number,
        error: String(error),
      });
    }
  }
  return closed;
}

/** One repository's pass. */
export async function liveTriage(
  app: App,
  repo: Repo,
  now = new Date(),
): Promise<Triaged> {
  const did = none();
  if (repo.archivedAt !== null || repo.autonomyBy === null) return did;
  if (isMirror(app, repo)) return did;
  const by = getUserById(app.db, repo.autonomyBy);
  if (!by) return did;
  did.closed += foldDuplicates(app, repo, by, MOST_CHANGES);
  try {
    [did.labelled, did.missed] = file(app, repo, by, now);
  } catch (error) {
    log.error("filing failed", { repo: `${repo.ownerName}/${repo.name}`, error: String(error) });
  }
  const ids = candidates(app, repo);
  const noted = alreadyDone(app.db, ids);
  if (noted.size === 0) {
    fold(app, repo, by, did);
    return did;
  }
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  for (const id of ids) {
    const oids = noted.get(id);
    if (oids === undefined) continue;
    if (did.closed >= MOST_CHANGES) break;
    const issue = getIssueById(app.db, id);
    if (!issue || issue.state !== "open") continue;
    if (reopenedByPerson(app.db, repo.id, issue.number)) continue;
    const there = await onBase(dir, repo.defaultBranch, oids);
    if (there.length !== oids.length) continue;
    try {
      const closed = setIssueState(app, by, repo, issue, "closed", {
        reason: "done",
        triage: true,
      });
      if (closed.ok && closed.value.state === "closed") did.closed++;
    } catch (error) {
      // A rolled-back change: nothing was written and nothing announced.
      log.error("close failed", {
        repo: `${repo.ownerName}/${repo.name}`,
        issue: issue.number,
        error: String(error),
      });
    }
  }
  fold(app, repo, by, did);
  return did;
}
