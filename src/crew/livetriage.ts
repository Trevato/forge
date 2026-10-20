/**
 * Live triage (#3242). Two rules, no run, no spend.
 *
 * Filing (#3266): an open issue an hour old that serves no pillar gets one —
 * the pillar its title, else its body, names — or else waits behind the
 * Later gate, with a one-line comment saying so. A person undoes it by
 * naming a pillar, or by unlinking the gate: the note stays, so it is not
 * done twice. Directions, umbrellas and the gate itself are left alone, and
 * a repository with no pillars and no gate has nothing to file under.
 *
 * Closing: an issue the crew found already done on
 * the base branch stops waiting for a person to close it. Rules only, no
 * run, no spend. Only the crew's own note (`ALREADY_NOTE`, read through
 * `alreadyDone`) with every commit it names reachable from the default
 * branch closes anything; one commit that is not there leaves the issue
 * open. A second pass over the same state changes nothing, because a closed
 * issue is no longer a candidate.
 *
 * The close is `setIssueState`, whose state change is committed before the
 * event is published; the counters here move only after it returns, so a
 * change that rolled back is neither counted nor announced.
 */

import type { App } from "../app.ts";
import { linkIssue } from "../actions/dependencies.ts";
import { addComment, setIssueState } from "../actions/issues.ts";
import { alreadyDone, CLOSED_NOTE, DONE_LIKE } from "../core/done_on_main.ts";
import { getIssueById, getIssuesByIds, type Issue } from "../core/issues.ts";
import { isStructural, pillarsOf, servedBy, type Pillar, type Pillars } from "../core/pillars.ts";
import type { Repo } from "../core/repos.ts";
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
  /** Issues given a pillar or put behind the Later gate. */
  labelled: number;
  /** Open issues over an hour old that serve no pillar and that triage has yet to file. */
  missed: number;
}

export const none = (): Triaged => ({ closed: 0, labelled: 0, missed: 0 });

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
 * File old, unplaced issues; returns how many were, and how many were left
 * unplaced. The link comes first: if the note then fails the issue is still
 * placed, which is the part that matters, and the failure is logged.
 */
function file(app: App, repo: Repo, by: User, now: Date): [number, number] {
  const set = pillarsOf(app.db, repo);
  if (set.pillars.length === 0 && set.gate === undefined) return [0, 0];
  const todo = unfiled(app, repo, set, now);
  let filed = 0;
  for (const issue of todo) {
    if (filed >= MOST_CHANGES) break;
    const pillar = namedPillar(set, issue);
    if (pillar === undefined && set.gate === undefined) continue;
    try {
      const linked =
        pillar !== undefined
          ? linkIssue(app, by, repo, pillar.umbrella, issue)
          : linkIssue(app, by, repo, issue, set.gate!);
      if (!linked.ok) continue;
      filed++;
      addComment(
        app,
        by,
        repo,
        issue,
        pillar !== undefined
          ? `${FILED_NOTE} filed under ${pillar.name}, which it names.`
          : `${FILED_NOTE} no pillar named, so it waits behind the Later gate; name a pillar to move it.`,
      );
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
    labelled: did.labelled,
    ...(did.missed === 0 ? {} : { triageMiss: did.missed }),
  };
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
  try {
    [did.labelled, did.missed] = file(app, repo, by, now);
  } catch (error) {
    log.error("filing failed", { repo: `${repo.ownerName}/${repo.name}`, error: String(error) });
  }
  const ids = candidates(app, repo);
  const noted = alreadyDone(app.db, ids);
  if (noted.size === 0) return did;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  for (const id of ids) {
    const oids = noted.get(id);
    if (oids === undefined) continue;
    if (did.closed >= MOST_CHANGES) break;
    const issue = getIssueById(app.db, id);
    if (!issue || issue.state !== "open") continue;
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
  return did;
}
