/**
 * "Next up" as data (#8694): the owner's one ranked list, read from the
 * graph. The list is the ranked open issues in rank order, then what is
 * ready and unranked in the ready order; each row says who is on it and, in
 * one line, why it cannot start yet. What is deferred behind the Later gate
 * is "Not now": counted, and listed only when asked. Plain data in and out.
 */

import type { Database } from "bun:sqlite";
import { type Graph, type Ranked, reachOf, readyNow, repoGraph } from "./dependencies.ts";
import { fromAppIssues } from "./from_app.ts";
import type { Issue } from "./issues.ts";
import { pillarsOf, servedBy } from "./pillars.ts";
import type { Repo } from "./repos.ts";
import { listActiveRuns } from "./runs.ts";
import { getUserById } from "./users.ts";

/** How many rows the page shows before the rest is one line. */
export const TOP = 10;
/** The most "Not now" rows one page lists. */
export const NOT_NOW_MAX = 100;
/** How many blockers a reason names before it counts the rest. */
const NAMED = 3;

/**
 * A blocker holds other open work up; an enabler holds nothing up and is
 * work for what it makes possible. A label for the reader; the order is the
 * owner's rank, then the ready order.
 */
export type Role = "blocker" | "enabler";

export interface NextRow {
  readonly issue: Issue;
  readonly role: Role;
  /** In one line, what the role means here: what finishing a blocker frees, why an enabler is now. */
  readonly roleWhy: string;
  /** Place on the owner's list, 1 at the top; null for ready work nobody ranked. */
  readonly place: number | null;
  /** Who is on it: the crew member running it, else its assignee. */
  readonly onIt: string | null;
  /** In one line, why it cannot start yet; null when it can. A ready row has one whenever a builder will not start it. */
  readonly why: string | null;
}

export interface NextUp {
  /** Ranked first, then ready; every row is a candidate for the picker. */
  readonly rows: readonly NextRow[];
  /** Deferred work, "Not now", the oldest first, at most {@link NOT_NOW_MAX}. */
  readonly notNow: readonly NextRow[];
  /** All deferred open issues, listed or not. */
  readonly notNowTotal: number;
}

/** In one line, why this open issue cannot start yet; null when nothing stands in front of it. */
export function whyNot(graph: Graph, issue: Issue): string | null {
  const deferred = graph.deferred.get(issue.id);
  if (deferred !== undefined) return `not now: ${deferred}`;
  const open = new Map(graph.issues.filter((i) => i.state === "open").map((i) => [i.id, i]));
  const waits = graph.edges
    .filter((e) => e.issueId === issue.id && open.has(e.blockedById))
    .map((e) => open.get(e.blockedById)!.number)
    .sort((a, b) => a - b);
  if (waits.length > 0) {
    const named = waits.slice(0, NAMED).map((n) => `#${n}`).join(", ");
    return `waits for ${named}${waits.length > NAMED ? `, and ${waits.length - NAMED} more` : ""}`;
  }
  const held = graph.held.find((h) => h.issueId === issue.id);
  if (held !== undefined) return `a blocker closed as ${held.reason}: a person confirms the plan`;
  if (graph.unadopted.has(issue.id)) return "a reader's issue nobody who directs the crew has adopted";
  if (graph.structural.has(issue.id)) return "the plan's own: a person closes it";
  return null;
}

/** The role of an open issue and its one line. */
export function roleOf(
  holdsUp: number,
  serves: string | undefined,
  ranked: boolean,
): { role: Role; roleWhy: string } {
  if (holdsUp > 0)
    return { role: "blocker", roleWhy: `finishing it frees ${holdsUp}` };
  if (serves !== undefined) return { role: "enabler", roleWhy: `serves ${serves}` };
  return {
    role: "enabler",
    roleWhy: ranked ? "the owner ranked it" : "holds nothing up",
  };
}

/**
 * The whole order, once (#8826): what a person sent from an app first
 * (`first`, the `from-app` issues, #10365), then the ranked issues by place,
 * then the ready ones nobody ranked, in the ready order. Next up shows it and
 * the picker takes from it; neither keeps an order of its own. `blocked` is
 * the open ranked issues that are not ready: the page shows them in their
 * place, and the picker, which can only start what is ready, passes none.
 */
export function pickOrder<T>(
  ready: readonly T[],
  ranks: ReadonlyMap<string, number>,
  idOf: (t: T) => string,
  blocked: readonly T[] = [],
  first: ReadonlySet<string> = new Set(),
): T[] {
  const place = (t: T) => ranks.get(idOf(t));
  const ahead = ready.filter((t) => first.has(idOf(t)));
  const rest = (t: T) => !first.has(idOf(t));
  const ranked = [...ready, ...blocked].filter((t) => rest(t) && place(t) !== undefined).sort((a, b) => place(a)! - place(b)!);
  return [...ahead, ...ranked, ...ready.filter((t) => rest(t) && place(t) === undefined)];
}

/** The list for one repository; `scope` is what `sealedScope` says the viewer may see. */
export function nextUp(
  db: Database,
  repo: Repo,
  scope: { sealed?: true; sealedBy?: string } = { sealed: true },
  /** Why a ready issue is not startable, by issue id (`crew/not_startable.ts`): a page that has the app passes it. */
  notStartable: (ready: readonly Ranked[]) => ReadonlyMap<string, string> = () => new Map(),
): NextUp {
  const graph = repoGraph(db, repo.id, { ...scope, lean: true });
  const ranks = graph.ranked ?? new Map<string, number>();
  const readyRanked = readyNow(graph);
  const ready = readyRanked.map((r) => r.issue);
  const unstartable = notStartable(readyRanked);
  const readyIds = new Set(ready.map((i) => i.id));
  // Who is on an issue: the crew running it right now, else whoever it is assigned to.
  const crew = new Map<string, string>();
  for (const run of listActiveRuns(db, [repo.id])) {
    const who = run.actorId === null ? undefined : getUserById(db, run.actorId)?.username;
    if (run.issueId !== null && who !== undefined) crew.set(run.issueId, who);
  }
  const holds = reachOf(graph).holds;
  const serves = servedBy(db, pillarsOf(db, repo));
  const rowOf = (issue: Issue): NextRow => ({
    issue,
    ...roleOf(holds.get(issue.id)?.size ?? 0, serves.get(issue.id), ranks.has(issue.id)),
    place: ranks.get(issue.id) ?? null,
    onIt: crew.get(issue.id) ?? issue.assigneeName,
    why: readyIds.has(issue.id) ? unstartable.get(issue.id) ?? null : whyNot(graph, issue),
  });
  const blocked = graph.issues.filter((i) => i.state === "open" && ranks.has(i.id) && !readyIds.has(i.id));
  const rows = pickOrder(ready, ranks, (i) => i.id, blocked, fromAppIssues(db, ready.map((i) => i.id))).map(rowOf);
  const listed = new Set(rows.map((r) => r.issue.id));
  const away = graph.issues.filter(
    (i) => i.state === "open" && graph.deferred.has(i.id) && !listed.has(i.id) && !graph.structural.has(i.id),
  );
  return { rows, notNow: away.slice(0, NOT_NOW_MAX).map(rowOf), notNowTotal: away.length };
}
