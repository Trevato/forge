/**
 * How the work is growing or shrinking (#11604): per day for the last `days` days, issues opened (by
 * who) and closed, pulls opened, landed and closed unmerged, the open totals now, and the sentences
 * computed from them. Opened-per-day is a range walk of `issue_repo_created`, which the migration
 * `planner-pause` adds. Closed-per-day has no index of its own (one made `windowShipped`'s plan sort,
 * `test/week-sprint.test.ts`): it walks the repository's rows through the existing `repo_id` index, one
 * repository's issues and never the table. Every read leaves out sealed issues the viewer may not see
 * (`core/sealed.ts`). Plain data out.
 */

import type { Database } from "bun:sqlite";
import type { sealedScope } from "./sealed.ts";

/** What `sealedScope` answered for the viewer. */
export type Scope = ReturnType<typeof sealedScope>;

/** `AND …` leaving out sealed rows the viewer may not see; `a` and `b` are the two parameter numbers it uses. */
const visible = (a: number, b: number): string => `AND (i.sealed = 0 OR ?${a} = 1 OR i.author_id = ?${b})`;
const visibleArgs = (scope: Scope): [number, string] => [scope.sealed === true ? 1 : 0, scope.sealedBy ?? ""];

export type Who = "owner" | "people" | "planner" | "builders" | "watchers";
export const WHO: readonly Who[] = ["owner", "people", "planner", "builders", "watchers"];

export interface Day {
  readonly day: string;
  readonly issuesOpened: number;
  readonly issuesClosed: number;
  readonly openedBy: Readonly<Record<Who, number>>;
  readonly pullsOpened: number;
  readonly pullsLanded: number;
  readonly pullsClosed: number;
}

export interface Growth {
  readonly days: readonly Day[];
  readonly open: { readonly issues: number; readonly pulls: number };
  /** Net issues per day over the window: opened minus closed, averaged. */
  readonly perDay: number;
  /** Days of work at the current pace of closing; null when nothing is closing. */
  readonly daysQueued: number | null;
  /** How many days in a row, ending today, the list grew. */
  readonly growingRun: number;
  readonly sentences: readonly string[];
  /** A suggestion to pause, never an automatic pause. */
  readonly suggest: string | null;
}

export const MAX_DAYS = 90;
const DAY_MS = 86_400_000;

/** The window as ISO days, oldest first, ending with `now`'s UTC day. */
export function windowDays(now: Date, days: number): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/** Whom an issue's author is, over `i.author_id` and `rc.role`; `?3` is the owner's id. */
const WHO_SQL = `CASE
    WHEN i.author_id = ?3 THEN 'owner'
    WHEN rc.role = 'planner' THEN 'planner'
    WHEN rc.role = 'builder' THEN 'builders'
    WHEN EXISTS (SELECT 1 FROM agent a WHERE a.user_id = i.author_id) THEN 'watchers'
    ELSE 'people' END`;

const n = (x: number): string => String(Math.round(x));
const plural = (x: number, one: string, many: string): string => `${x} ${x === 1 ? one : many}`;

type Tally = {
  day: string;
  issuesOpened: number;
  issuesClosed: number;
  openedBy: Record<Who, number>;
  pullsOpened: number;
  pullsLanded: number;
  pullsClosed: number;
};

/** The panel's numbers for one repository. */
export function growth(db: Database, repo: { id: string; ownerId: string }, days: number, now: Date, scope: Scope = {}): Growth {
  const labels = windowDays(now, days);
  const [all, mine] = visibleArgs(scope);
  const from = `${labels[0]}T00:00:00.000Z`;
  const rows = new Map<string, Tally>();
  for (const day of labels)
    rows.set(day, {
      day, issuesOpened: 0, issuesClosed: 0, pullsOpened: 0, pullsLanded: 0, pullsClosed: 0,
      openedBy: { owner: 0, people: 0, planner: 0, builders: 0, watchers: 0 },
    });

  const opened = db
    .query<{ day: string; k: string; who: Who; c: number }, [string, string, string, number, string]>(
      `SELECT substr(i.created_at,1,10) AS day, i.kind AS k, ${WHO_SQL} AS who, COUNT(*) AS c
         FROM issue i
         LEFT JOIN repo_crew rc ON rc.repo_id = i.repo_id AND rc.user_id = i.author_id
        WHERE i.repo_id = ?1 AND i.created_at >= ?2 ${visible(4, 5)}
        GROUP BY day, k, who`,
    )
    .all(repo.id, from, repo.ownerId, all, mine);
  for (const r of opened) {
    const d = rows.get(r.day);
    if (d === undefined) continue;
    if (r.k === "pull") d.pullsOpened += r.c;
    else {
      d.issuesOpened += r.c;
      d.openedBy[r.who] += r.c;
    }
  }
  const closedRows = db
    .query<{ day: string; k: string; landed: number; c: number }, [string, string, number, string]>(
      `SELECT substr(i.closed_at,1,10) AS day, i.kind AS k,
              (p.merged_at IS NOT NULL) AS landed, COUNT(*) AS c
         FROM issue i LEFT JOIN pull p ON p.issue_id = i.id
        WHERE i.repo_id = ?1 AND i.closed_at IS NOT NULL AND i.closed_at >= ?2 ${visible(3, 4)}
        GROUP BY day, k, landed`,
    )
    .all(repo.id, from, all, mine);
  for (const r of closedRows) {
    const d = rows.get(r.day);
    if (d === undefined) continue;
    if (r.k === "issue") d.issuesClosed += r.c;
    else if (r.landed === 1) d.pullsLanded += r.c;
    else d.pullsClosed += r.c;
  }
  const open = db
    .query<{ kind: string; c: number }, [string, number, string]>(
      `SELECT i.kind, COUNT(*) AS c FROM issue i WHERE i.repo_id = ?1 AND i.state = 'open' ${visible(2, 3)} GROUP BY i.kind`,
    )
    .all(repo.id, all, mine);
  const openIssues = open.find((o) => o.kind === "issue")?.c ?? 0;
  const openPulls = open.find((o) => o.kind === "pull")?.c ?? 0;

  const list = labels.map((l) => rows.get(l)!);
  const totalOpened = list.reduce((s, d) => s + d.issuesOpened, 0);
  const totalClosed = list.reduce((s, d) => s + d.issuesClosed, 0);
  const perDay = (totalOpened - totalClosed) / days;
  const pace = totalClosed / days;
  const daysQueued = pace > 0 ? openIssues / pace : null;
  let growingRun = 0;
  for (let i = list.length - 1; i >= 0 && list[i]!.issuesOpened > list[i]!.issuesClosed; i--) growingRun++;

  const dir = perDay > 0 ? "growing" : perDay < 0 ? "shrinking" : "steady";
  const sentences = [
    dir === "steady" || Math.round(Math.abs(perDay)) === 0
      ? "The list of issues is holding steady."
      : `The list of issues is ${dir} by ${n(Math.abs(perDay))} a day.`,
    daysQueued === null
      ? `${plural(openIssues, "issue is", "issues are")} queued and none closed in ${days} days, so there is no pace to count by.`
      : `${plural(openIssues, "issue is", "issues are")} queued: ${n(daysQueued)} days of work at the current pace.`,
  ];
  const suggest =
    growingRun >= 3
      ? `The list has grown ${growingRun} days running: you may want to pause the planner for a while.`
      : daysQueued !== null && daysQueued > 14
        ? `${n(daysQueued)} days of work are queued, past two weeks: you may want to pause the planner for a while.`
        : null;
  return { days: list, open: { issues: openIssues, pulls: openPulls }, perDay, daysQueued, growingRun, sentences, suggest };
}

export interface Aged {
  readonly number: number;
  readonly title: string;
  readonly openedAt: string;
}

/** The oldest open pull and the oldest open issue no run has started on: what age looks like, honestly. */
export function oldest(db: Database, repoId: string, scope: Scope = {}): { pull: Aged | null; issue: Aged | null } {
  const one = (kind: "issue" | "pull", unstarted: boolean): Aged | null => {
    const r = db
      .query<{ number: number; title: string; created_at: string }, [string, string, number, string]>(
        `SELECT i.number, i.title, i.created_at FROM issue i
          WHERE i.repo_id = ?1 AND i.state = 'open' AND i.kind = ?2 ${visible(3, 4)}
            ${unstarted ? "AND NOT EXISTS (SELECT 1 FROM run r WHERE r.issue_id = i.id)" : ""}
          ORDER BY i.created_at LIMIT 1`,
      )
      .get(repoId, kind, ...visibleArgs(scope));
    return r === null ? null : { number: r.number, title: r.title, openedAt: r.created_at };
  };
  return { pull: one("pull", false), issue: one("issue", true) };
}
