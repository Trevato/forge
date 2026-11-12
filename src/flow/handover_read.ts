/**
 * The three lists /flow and its terminal screen share (#11456): pulls handed
 * to a person in the last 24 h, pulls one changes-requested round from that,
 * and the five open pulls to bring up to date first. Plain SQL, one query per
 * list however many pulls are open; the drifts are passed in (the callers
 * already read them). Open pulls only: a closed or merged pull needs no help.
 */

import type { Database } from "bun:sqlite";
import { HANDOVER_NOTE } from "../crew/guard.ts";
import type { RepoDrift } from "./alarm_drift.ts";
import { inWindow } from "./handovers.ts";
import { rebaseFirst, type RebaseDrift } from "./rebase_first.ts";
import { nearHandover, type Verdict } from "./review_rounds.ts";

/** A pull named by repository and number. */
export interface Named {
  readonly repo: string;
  readonly number: number;
}

export interface HandoverLists {
  readonly handed: readonly Named[];
  readonly near: readonly Named[];
  readonly rebase: readonly Named[];
}

const key = (n: Named): string => `${n.repo}#${String(n.number)}`;

const OPEN = `i.kind = 'pull' AND i.state = 'open' AND p.merged_at IS NULL`;
const FROM = `issue i JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id JOIN user o ON o.id = r.owner_id`;

/** Pulls handed to a person in the last 24 h, newest first: the newest hand-over note by the assignee's own name on each. */
export function readHandovers(db: Database, now: number): Named[] {
  return db
    .query<{ repo: string; number: number; at: string }, [string]>(
      `SELECT o.username || '/' || r.name AS repo, i.number AS number, MAX(c.created_at) AS at
         FROM comment c JOIN issue i ON i.id = c.issue_id AND c.author_id = i.assignee_id
         JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id JOIN user o ON o.id = r.owner_id
        WHERE ${OPEN} AND substr(c.body, 1, ${String(HANDOVER_NOTE.length)}) = ?1
        GROUP BY i.id`,
    )
    .all(HANDOVER_NOTE)
    .filter((r) => inWindow(r.at, now))
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || x.repo.localeCompare(y.repo) || y.number - x.number)
    .map((r) => ({ repo: r.repo, number: r.number }));
}

interface Open {
  readonly id: string;
  readonly named: Named;
  readonly verdicts: Verdict[];
}

/** Every open pull with its approved / changes-requested verdicts in order: two queries in all. */
function openWithVerdicts(db: Database): Open[] {
  const open = new Map<string, Open>();
  for (const r of db
    .query<{ id: string; repo: string; number: number }, []>(`SELECT i.id AS id, o.username || '/' || r.name AS repo, i.number AS number FROM ${FROM} WHERE ${OPEN} ORDER BY i.number`)
    .all())
    open.set(r.id, { id: r.id, named: { repo: r.repo, number: r.number }, verdicts: [] });
  for (const v of db
    .query<{ issue_id: string; state: Verdict }, []>(
      `SELECT v.issue_id, v.state FROM review v JOIN issue i ON i.id = v.issue_id JOIN pull p ON p.issue_id = i.id
        WHERE ${OPEN} AND v.state IN ('approved','changes_requested') ORDER BY v.issue_id, v.created_at, v.id`,
    )
    .all())
    open.get(v.issue_id)?.verdicts.push(v.state);
  return [...open.values()];
}

/** Open pulls whose trailing run of changes-requested reviews is two, the most recent first. */
export function readReviewRounds(db: Database): Named[] {
  return nearHandover(openWithVerdicts(db).map((p) => ({ pull: p.named, verdicts: p.verdicts })));
}

/** The pulls to bring up to date first, from the drifts the caller already read. */
export function readRebaseFirst(db: Database, drifts: readonly RepoDrift[], now: number): Named[] {
  const open = new Map(openWithVerdicts(db).map((p) => [key(p.named), p]));
  const held = new Set(db.query<{ issue_id: string }, []>("SELECT issue_id FROM pull_hold WHERE released_at IS NULL").all().map((h) => h.issue_id));
  const behind = drifts.filter((d) => d.landings > 0 && open.has(key(d)));
  const picked = rebaseFirst(
    behind.map((d, i): RebaseDrift => {
      const p = open.get(key(d))!;
      return { number: i, behind: d.landings, baseAt: d.since ?? now, approved: p.verdicts.at(-1) === "approved", held: held.has(p.id) };
    }),
    now,
  );
  return picked.map((i) => ({ repo: behind[i]!.repo, number: behind[i]!.number }));
}

export function readHandoverLists(db: Database, drifts: readonly RepoDrift[], now: number): HandoverLists {
  return { handed: readHandovers(db, now), near: readReviewRounds(db), rebase: readRebaseFirst(db, drifts, now) };
}
