/**
 * The roadmap (#10303): a repository's pillars in the order the crew works
 * them, as plain data. What is building, what landed, what is next and when
 * each pillar should finish. One model for the map page, the API and the MCP.
 *
 * Order, membership and served-by come from `core/pillars.ts`; the pace from
 * `mergedByPillar`. A pillar's ETA is its open work over its seven-day merge
 * rate, or none where nothing merged (a rate of zero projects no date).
 */

import type { Database } from "bun:sqlite";
import {
  idleFurniture,
  readyNow,
  repoGraph,
  type Graph,
} from "../core/dependencies.ts";
import type { Issue } from "../core/issues.ts";
import {
  LATER,
  mergedByPillar,
  pillarsOf,
  PILLAR_DAYS,
  servedBy,
} from "../core/pillars.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { listActiveRuns } from "../core/runs.ts";
import { sealedScope } from "../core/sealed.ts";
import type { User } from "../core/users.ts";
import { proposedWork } from "../crew/direct.ts";
import { marksFor, wordFor, type Marks } from "./pages/map.ts";

/** An issue as the roadmap names it. */
export interface RoadmapIssue {
  readonly number: number;
  readonly title: string;
  readonly assignee: string | null;
  /** The pull that waits for a person, where there is one. */
  readonly pull?: number;
  /** For a blocked issue: the open issue in front of it. */
  readonly blockedBy?: { readonly number: number; readonly title: string };
  /** When it last moved. */
  readonly at: string;
  /** Moved since the reader's previous visit. */
  readonly moved: boolean;
}

export type PillarState = "done" | "current" | "future";

export interface RoadmapPillar {
  /** `P3`, or `Later`. */
  readonly short: string;
  /** `P3 Cloud`, or `Later`. */
  readonly name: string;
  /** The umbrella's issue number, where there is one. */
  readonly umbrella: number | null;
  readonly state: PillarState;
  /** Done and counted issues; dropped, split and parked closes are neither. */
  readonly done: number;
  readonly total: number;
  /** Pulls merged for it in the last seven days. */
  readonly merged: number;
  readonly building: readonly RoadmapIssue[];
  readonly next: RoadmapIssue | null;
  readonly lastLanding: RoadmapIssue | null;
  /** Days to finish at the seven-day rate; null with no rate or nothing open. */
  readonly etaDays: number | null;
  readonly etaAt: string | null;
  readonly groups: {
    readonly building: readonly RoadmapIssue[];
    readonly upNext: readonly RoadmapIssue[];
    readonly waiting: readonly RoadmapIssue[];
    readonly blocked: readonly RoadmapIssue[];
    readonly doneThisWeek: readonly RoadmapIssue[];
  };
  /** Rows that moved since the reader last looked. */
  readonly movedCount: number;
}

export interface NeedsYou {
  readonly kind: "hold" | "close";
  readonly text: string;
  readonly action: string;
  /** Issue number the action opens. */
  readonly number: number;
  readonly pull: boolean;
}

export interface Roadmap {
  readonly generatedAt: string;
  readonly pace: {
    readonly landed24h: number;
    readonly landed7d: number;
    readonly days: number;
    readonly current: string | null;
    readonly etaDays: number | null;
    readonly etaAt: string | null;
  };
  readonly needsYou: readonly NeedsYou[];
  /** Pillars in order; Later, when the repository has one, is last. */
  readonly pillars: readonly RoadmapPillar[];
}

const DAY = 86_400_000;
const NEXT_MAX = 5;
const WEEK_MAX = 8;

/** Days to clear `open` issues at `merged` pulls in `PILLAR_DAYS` days. */
export function etaDays(open: number, merged: number): number | null {
  if (open <= 0 || merged <= 0) return null;
  return Math.max(1, Math.ceil((open * PILLAR_DAYS) / merged));
}

/** The repository's roadmap, or undefined where it names no pillars. */
export function roadmapOf(
  db: Database,
  repo: Repo,
  user: User | undefined,
  options: { now?: Date; since?: string } = {},
): Roadmap | undefined {
  const now = options.now ?? new Date();
  const since = options.since ?? "9999";
  const set = pillarsOf(db, repo);
  if (set.pillars.length === 0) return undefined;
  const served = servedBy(db, set);
  const scope = sealedScope(db, repo, user);
  const graph: Graph = repoGraph(db, repo.id, { ...scope, pillars: set, lean: true });
  const marks: Marks = marksFor(db, repo.id, graph, listActiveRuns(db, [repo.id]));
  const ready = readyNow(graph);
  const readySet = new Set(ready.map((r) => r.issue.id));
  const readyOrder = new Map(ready.map((r, n) => [r.issue.id, n]));
  const weekAgo = new Date(now.getTime() - PILLAR_DAYS * DAY).toISOString();
  const dayAgo = new Date(now.getTime() - DAY).toISOString();
  const week = mergedByPillar(db, repo.id, set, served, weekAgo);
  const day = mergedByPillar(db, repo.id, set, served, dayAgo);
  const sum = (rows: readonly { merged: number }[]): number =>
    rows.reduce((n, r) => n + r.merged, 0);

  const pulls = proposedWork(db, repo);
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const blocker = new Map<string, Issue>();
  for (const edge of graph.edges) {
    const b = byId.get(edge.blockedById);
    if (b !== undefined && b.state === "open" && !blocker.has(edge.issueId))
      blocker.set(edge.issueId, b);
  }

  const pullOf = new Map<string, number>();
  for (const [number, pull] of pulls) {
    const issue = graph.issues.find((i) => i.number === number);
    if (issue !== undefined) pullOf.set(issue.id, pull.number);
  }
  const item = (i: Issue, extra: Partial<RoadmapIssue> = {}): RoadmapIssue => {
    const at = i.state === "closed" ? (i.closedAt ?? i.updatedAt) : i.updatedAt;
    return {
      number: i.number,
      title: i.title,
      assignee: i.assigneeName,
      at,
      moved: at > since,
      ...extra,
    };
  };

  const names = [...set.pillars.map((p) => p.name)];
  const later = set.gate !== undefined || set.later !== undefined;
  if (later) names.push(LATER);
  const rows = names.map((name, n): RoadmapPillar => {
    const pillar = set.pillars[n];
    const issues = graph.issues.filter(
      (i) => !graph.structural.has(i.id) && served.get(i.id) === name,
    );
    const open = issues.filter((i) => i.state === "open");
    const closed = issues.filter(
      (i) => i.state === "closed" && (i.closeReason === null || i.closeReason === "done"),
    );
    const live = open.filter((i) => (!marks.parked.has(i.id) && !marks.deferred.has(i.id)) || name === LATER);
    const wordOf = (i: Issue) => wordFor(i, readySet, marks);
    const building = open.filter((i) => wordOf(i) === "working").map((i) => item(i));
    const upNext = open
      .filter((i) => wordOf(i) === "ready" && i.assigneeName === null)
      .sort((a, b) => (readyOrder.get(a.id) ?? 0) - (readyOrder.get(b.id) ?? 0))
      .map((i) => item(i));
    const waiting = open
      .filter((i) => ["waiting", "held"].includes(wordOf(i)))
      .map((i) => item(i, pullOf.has(i.id) ? { pull: pullOf.get(i.id)! } : {}));
    const blocked = open
      .filter((i) => wordOf(i) === "blocked")
      .map((i) => {
        const b = blocker.get(i.id);
        return item(i, b === undefined ? {} : { blockedBy: { number: b.number, title: b.title } });
      });
    const doneThisWeek = closed
      .filter((i) => (i.closedAt ?? "") >= weekAgo)
      .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))
      .map((i) => item(i));
    const last = [...closed].sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""))[0];
    const merged = week.find((w) => w.pillar === name)?.merged ?? 0;
    const eta = etaDays(live.length, merged);
    const total = closed.length + open.length;
    const all = [...building, ...upNext, ...waiting, ...blocked, ...doneThisWeek];
    return {
      short: pillar?.short ?? LATER,
      name,
      umbrella: pillar?.umbrella.number ?? set.later?.number ?? null,
      state: total > 0 && open.length === 0 ? "done" : "future",
      done: closed.length,
      total,
      merged,
      building,
      next: upNext[0] ?? null,
      lastLanding: last === undefined ? null : item(last),
      etaDays: eta,
      etaAt: eta === null ? null : new Date(now.getTime() + eta * DAY).toISOString(),
      groups: {
        building,
        upNext: upNext.slice(0, NEXT_MAX),
        waiting,
        blocked,
        doneThisWeek: doneThisWeek.slice(0, WEEK_MAX),
      },
      movedCount: all.filter((r) => r.moved).length,
    };
  });
  // The current pillar is the first, in order, with open work; Later is never current.
  const cur = rows.findIndex((r) => r.name !== LATER && r.state !== "done" && r.total > r.done);
  const pillars = rows.map((r, n) => (n === cur ? { ...r, state: "current" as const } : r));
  const current = pillars[cur];

  const needsYou: NeedsYou[] = [];
  if (user !== undefined && user.kind !== "agent" && canWrite(db, repo, user)) {
    const held = db
      .query<{ number: number; title: string; by: string; why: string }, [string, number, string]>(
        `SELECT issue.number, issue.title, user.username AS by, pull_hold.why
           FROM pull_hold JOIN issue ON issue.id = pull_hold.issue_id
           JOIN user ON user.id = pull_hold.held_by
          WHERE issue.repo_id = ?1 AND issue.kind = 'pull' AND issue.state = 'open'
            AND pull_hold.released_at IS NULL
            AND (?2 = 1 OR issue.sealed = 0 OR issue.author_id = ?3)
          ORDER BY pull_hold.held_at LIMIT 20`,
      )
      .all(repo.id, scope.sealed === true ? 1 : 0, scope.sealedBy ?? "");
    for (const hold of held)
      needsYou.push({
        kind: "hold",
        text: `${hold.by} holds #${hold.number} ${hold.title}: ${hold.why}`,
        action: "Open the pull",
        number: hold.number,
        pull: true,
      });
    for (const furniture of idleFurniture(graph))
      needsYou.push({
        kind: "close",
        text: `#${furniture.number} ${furniture.title.split(":")[0]} has nothing open in front of it`,
        action: "Close it or add work",
        number: furniture.number,
        pull: false,
      });
  }
  return {
    generatedAt: now.toISOString(),
    pace: {
      landed24h: sum(day),
      landed7d: sum(week),
      days: PILLAR_DAYS,
      current: current?.name ?? null,
      etaDays: current?.etaDays ?? null,
      etaAt: current?.etaAt ?? null,
    },
    needsYou,
    pillars,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Nov 20`, in UTC, from an ISO time. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** `finishes around Nov 20`, or `has no date yet` where there is no rate. */
export function finishWords(etaAt: string | null): string {
  return etaAt === null ? "has no date yet" : `finishes around ${shortDate(etaAt)}`;
}

/** The pace as sentences: what landed, then the current pillar's finish. */
export function paceSentence(road: Roadmap): string {
  const p = road.pace;
  const landed = `Landed ${p.landed24h} today and ${p.landed7d} in ${p.days} days.`;
  if (p.current === null) return `${landed} Every pillar is done.`;
  return `${landed} ${p.current} ${finishWords(p.etaAt)}.`;
}
