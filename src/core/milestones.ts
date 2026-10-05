/**
 * Milestones (#731): how far each thing asked for is, read from the
 * dependency tree. Nothing is stored. A milestone is an issue that waits
 * for others; what is beneath it is everything it waits for, directly or
 * through others. The plan's own furniture is not beneath anything — one
 * pillar's umbrella waiting for another is an order between pillars, and
 * the Later gate waits for all of them (`pillars.ts`).
 *
 * `readPlan` is one pass over one repository: its graph, its pillars, the
 * runs in flight, the week's merged pulls and, for a viewer who may see
 * them, what each issue cost. A fixed handful of reads however many issues
 * there are; every number on the page, in the API and in the MCP tool comes
 * from it.
 */

import type { Database } from "bun:sqlite";
import { deferredIn, repoGraph, type Graph } from "./dependencies.ts";
import type { Issue } from "./issues.ts";
import {
  isStructural,
  LATER,
  PILLAR_DAYS,
  pillarsOf,
  pillarWindowStart,
  type Pillars,
} from "./pillars.ts";
import { closesFromBody, openPullsClosing } from "./pulls.ts";
import type { Repo } from "./repos.ts";
import { listActiveRuns } from "./runs.ts";
import { getUsersByIds } from "./users.ts";

/** A limb with this many open issues beneath it and nobody building is one to look at. */
export const TRIM_OPEN = 8;

/** How heavy a limb is: what is beneath it, and whether it moves. */
export interface Weight {
  /** The work beneath it: what is open, and what closed as done. */
  readonly total: number;
  readonly done: number;
  readonly open: number;
  /** Open issues beneath it the crew is on right now. */
  readonly building: number;
  /** Pulls merged for it in the last `PILLAR_DAYS` days. */
  readonly merged: number;
  /** When anything beneath it last moved; null when nothing is beneath it. */
  readonly last: string | null;
  /** What the crew's runs beneath it cost, in US dollars: owner facts only. */
  readonly spentUsd?: number;
}

/** One limb as a line: a milestone, collapsed. */
export interface Limb {
  readonly issue: Issue;
  /** A pillar's name for its umbrella; the issue's title otherwise. */
  readonly name: string;
  readonly weight: Weight;
  /** Deferred on purpose: Later, or a limb behind the gate. Never a candidate to trim. */
  readonly deferred: boolean;
  /** Why, in plain words: "behind the Later gate", or which deferred limb needs it. */
  readonly deferredBecause?: string;
  /** Why it is a candidate to trim, when it is one. */
  readonly trim?: string;
}

/** How an issue beneath a milestone stands. */
export type LeafState =
  | "done"
  | "gone"
  | "building"
  | "proposed"
  | "deferred"
  | "blocked"
  | "ready";

/** One milestone, opened. */
export interface Milestone extends Limb {
  /** Who is on what beneath it, right now. */
  readonly building: readonly {
    readonly issue: Issue;
    /** The agent's username, or null when nobody is named on the run. */
    readonly who: string | null;
    readonly since: string;
  }[];
  /** What beneath it cannot move, and what each waits for. */
  readonly blocked: readonly {
    readonly issue: Issue;
    readonly on: readonly Issue[];
  }[];
  /** The pulls merged for it in the last `PILLAR_DAYS` days, newest first. */
  readonly merged: readonly {
    readonly number: number;
    readonly title: string;
    readonly at: string;
  }[];
  /** A plain sentence: when it lands at this week's pace, or why nobody can say. */
  readonly estimate: string;
  /** What it waits for directly that has a tree of its own. */
  readonly limbs: readonly Limb[];
  /** What it waits for directly that brings none: at most an order among these. */
  readonly leaves: readonly {
    readonly issue: Issue;
    readonly state: LeafState;
    /** For a deferred leaf: why. */
    readonly why?: string;
  }[];
}

export interface Plan {
  /** The top-level limbs, in order: the pillars and Later, or the plan's roots. */
  readonly limbs: readonly Limb[];
  /**
   * One milestone by its issue's number; nothing for an issue that waits for
   * nothing. An issue that waits only for the plan's furniture has a
   * milestone with nothing beneath it, which says so.
   */
  milestone(number: number): Milestone | undefined;
  /**
   * A limb as rows, top down — what an action on the whole limb selects.
   * `own` is the issue of that number and everything beneath it that only
   * the limb needs; `shared` is what is beneath it that something open
   * outside the limb also waits for, and so is not the limb's to take.
   * Nothing for a number that is no issue here.
   */
  limb(number: number): { own: Issue[]; shared: Issue[] } | undefined;
  /**
   * What deferring this issue would take with it: the open issues that
   * would stop being ready, itself included, and, beneath it, the ones that
   * would stay because something active still waits for them.
   */
  deferral(number: number): { taken: Issue[]; kept: Issue[] } | undefined;
  /**
   * What resuming this issue would give back: the open issues, itself
   * included, that are deferred now and would not be once it is out from
   * behind the gate.
   */
  resumption(number: number): Issue[] | undefined;
}

interface MergedPull {
  readonly number: number;
  readonly title: string;
  readonly at: string;
  readonly closes: readonly number[];
}

/** Is it work that counts: open, or finished. Dropped and split are neither. */
const counted = (issue: Issue): boolean =>
  issue.state === "open" ||
  issue.closeReason === "done" ||
  issue.closeReason === null;

/**
 * Read one repository's plan as milestones. `spend` adds what each limb
 * cost, for a viewer who may see owner facts — the caller decides.
 */
export function readPlan(
  db: Database,
  repo: Repo,
  options: { readonly spend: boolean; readonly now?: Date } = { spend: false },
): Plan {
  const now = options.now ?? new Date();
  const since = pillarWindowStart(now);
  const graph: Graph = repoGraph(db, repo.id);
  const set: Pillars = pillarsOf(db, repo);
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const byNumber = new Map(graph.issues.map((i) => [i.number, i]));

  // What each issue waits for directly, furniture left out.
  const waitsFor = new Map<string, string[]>();
  const waitedBy = new Map<string, string[]>();
  const waits = new Set<string>();
  for (const edge of graph.edges) {
    waits.add(edge.issueId);
    if (isStructural(set, edge.blockedById)) continue;
    waitsFor.set(edge.issueId, [
      ...(waitsFor.get(edge.issueId) ?? []),
      edge.blockedById,
    ]);
    waitedBy.set(edge.blockedById, [
      ...(waitedBy.get(edge.blockedById) ?? []),
      edge.issueId,
    ]);
  }
  // Work behind the gate is Later's whether or not the Later umbrella waits
  // for it: its milestone counts what the map's Later row counts.
  const behindGate =
    set.gate === undefined
      ? []
      : graph.edges
          .filter(
            (e) =>
              e.blockedById === set.gate!.id && !isStructural(set, e.issueId),
          )
          .map((e) => e.issueId);
  if (set.later !== undefined && behindGate.length > 0) waits.add(set.later.id);
  /** What an issue waits for directly, as its milestone shows it. */
  const childrenOf = (id: string): string[] =>
    id === set.later?.id
      ? [...new Set([...(waitsFor.get(id) ?? []), ...behindGate])]
      : (waitsFor.get(id) ?? []);
  const memo = new Map<string, Set<string>>();
  const walking = new Set<string>();
  const beneath = (id: string): Set<string> => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (walking.has(id)) return new Set();
    walking.add(id);
    const out = new Set<string>();
    for (const child of childrenOf(id)) {
      out.add(child);
      for (const deeper of beneath(child)) out.add(deeper);
    }
    walking.delete(id);
    memo.set(id, out);
    return out;
  };

  // Where the crew is: the issue a run is on, or the issue its pull closes.
  const proposed = openPullsClosing(db, repo.id);
  const issueOfPull = new Map<string, string>();
  for (const [number, pull] of proposed) {
    const issue = byNumber.get(number);
    if (issue !== undefined && !issueOfPull.has(pull.id))
      issueOfPull.set(pull.id, issue.id);
  }
  const runs = listActiveRuns(db, [repo.id]);
  const actors = getUsersByIds(
    db,
    runs.map((r) => r.actorId).filter((id): id is string => id !== null),
  );
  const building = new Map<string, { who: string | null; since: string }>();
  for (const run of runs) {
    if (run.issueId === null) continue;
    const issueId = byId.has(run.issueId)
      ? run.issueId
      : issueOfPull.get(run.issueId);
    if (issueId === undefined || building.has(issueId)) continue;
    building.set(issueId, {
      who:
        run.actorId === null ? null : (actors.get(run.actorId)?.username ?? null),
      since: run.startedAt ?? run.createdAt,
    });
  }

  // The week's merged pulls, by the issues each closes.
  const merged: MergedPull[] = db
    .query<
      { number: number; title: string; body: string; at: string },
      [string, string]
    >(
      `SELECT i.number, i.title, i.body, p.merged_at AS at
         FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id = ?1 AND p.merged_at IS NOT NULL AND p.merged_at >= ?2
        ORDER BY p.merged_at DESC LIMIT 1000`,
    )
    .all(repo.id, since)
    .map((row) => ({
      number: row.number,
      title: row.title,
      at: row.at,
      closes: closesFromBody(row.body),
    }));

  // What each issue cost: its own runs, and the runs on the pulls for it.
  const cost = new Map<string, number>();
  if (options.spend) {
    const rows = db
      .query<{ id: string; kind: string; body: string; usd: number }, [string]>(
        `SELECT i.id, i.kind, i.body, SUM(r.cost_usd) AS usd
           FROM run r JOIN issue i ON i.id = r.issue_id
          WHERE r.repo_id = ?1 AND r.kind = 'agent' AND r.cost_usd > 0
          GROUP BY i.id`,
      )
      .all(repo.id);
    for (const row of rows) {
      const issueId =
        row.kind === "issue"
          ? row.id
          : closesFromBody(row.body)
              .map((number) => byNumber.get(number)?.id)
              .find((id) => id !== undefined);
      if (issueId !== undefined)
        cost.set(issueId, (cost.get(issueId) ?? 0) + row.usd);
    }
  }

  const stateOf = (issue: Issue): LeafState => {
    if (issue.state === "closed") return counted(issue) ? "done" : "gone";
    if (building.has(issue.id)) return "building";
    if (proposed.has(issue.number)) return "proposed";
    if (graph.deferred.has(issue.id)) return "deferred";
    const open = (waitsFor.get(issue.id) ?? []).some(
      (id) => byId.get(id)?.state === "open",
    );
    return open ? "blocked" : "ready";
  };

  const nameOf = (issue: Issue): string => {
    if (set.later?.id === issue.id) return LATER;
    return (
      set.pillars.find((p) => p.umbrella.id === issue.id)?.name ?? issue.title
    );
  };

  const limbOf = (issue: Issue): Limb => {
    const under = [...beneath(issue.id)]
      .map((id) => byId.get(id))
      .filter((i): i is Issue => i !== undefined && counted(i));
    const numbers = new Set(under.map((i) => i.number));
    const open = under.filter((i) => i.state === "open");
    const landed = merged.filter((pull) =>
      pull.closes.some((n) => numbers.has(n)),
    );
    let last: string | null = null;
    for (const i of under) if (last === null || i.updatedAt > last) last = i.updatedAt;
    for (const pull of landed) if (last === null || pull.at > last) last = pull.at;
    const weight: Weight = {
      total: under.length,
      done: under.length - open.length,
      open: open.length,
      building: open.filter((i) => building.has(i.id)).length,
      merged: landed.length,
      last,
      ...(options.spend
        ? {
            spentUsd: under.reduce((sum, i) => sum + (cost.get(i.id) ?? 0), 0),
          }
        : {}),
    };
    const deferred = graph.deferred.has(issue.id);
    const closedThisWeek = under.some(
      (i) => i.state === "closed" && (i.closedAt ?? "") >= since,
    );
    // Still for a week means it has been here a week: a limb made today
    // with nothing landed yet is new, not stuck.
    const trim = deferred
      ? undefined
      : weight.open > 0 &&
          weight.merged === 0 &&
          !closedThisWeek &&
          issue.createdAt < since
        ? `nothing landed in ${PILLAR_DAYS} days`
        : weight.open >= TRIM_OPEN && weight.building === 0
          ? `${weight.open} open and nobody building`
          : undefined;
    const why = graph.deferred.get(issue.id);
    return {
      issue,
      name: nameOf(issue),
      weight,
      deferred,
      ...(why === undefined ? {} : { deferredBecause: why }),
      ...(trim === undefined ? {} : { trim }),
    };
  };

  const isMilestone = (id: string): boolean => childrenOf(id).length > 0;

  const top: Issue[] =
    set.pillars.length > 0
      ? [
          ...set.pillars.map((p) => p.umbrella),
          ...(set.later === undefined ? [] : [set.later]),
        ]
      : graph.issues.filter(
          (i) =>
            i.state === "open" &&
            isMilestone(i.id) &&
            !(waitedBy.get(i.id) ?? []).some(
              (id) => byId.get(id)?.state === "open",
            ),
        );

  return {
    limbs: top.map(limbOf),
    limb(number: number): { own: Issue[]; shared: Issue[] } | undefined {
      const issue = byNumber.get(number);
      if (issue === undefined) return undefined;
      const order = [issue.id];
      const inside = new Set(order);
      for (let n = 0; n < order.length; n++)
        for (const child of waitsFor.get(order[n]!) ?? [])
          if (!inside.has(child)) {
            inside.add(child);
            order.push(child);
          }
      // Shared: something open outside the limb waits for it, directly or
      // through something beneath the limb that is itself shared.
      const shared = new Set<string>();
      for (let grew = true; grew; ) {
        grew = false;
        for (const id of order) {
          if (id === issue.id || shared.has(id)) continue;
          const needed = (waitedBy.get(id) ?? []).some(
            (w) =>
              byId.get(w)?.state === "open" &&
              (!inside.has(w) || shared.has(w)),
          );
          if (needed) {
            shared.add(id);
            grew = true;
          }
        }
      }
      const issues = order
        .map((id) => byId.get(id))
        .filter((i): i is Issue => i !== undefined);
      return {
        own: issues.filter((i) => !shared.has(i.id)),
        shared: issues.filter((i) => shared.has(i.id)),
      };
    },
    deferral(number: number): { taken: Issue[]; kept: Issue[] } | undefined {
      const issue = byNumber.get(number);
      if (issue === undefined || set.gate === undefined) return undefined;
      const after = deferredIn(graph, set.gate.id, set.later?.id, [issue.id]);
      const under = [issue, ...beneath(issue.id)]
        .map((i) => (typeof i === "string" ? byId.get(i) : i))
        .filter((i): i is Issue => i !== undefined && i.state === "open");
      const byNumberAsc = (a: Issue, b: Issue) => a.number - b.number;
      return {
        taken: under
          .filter((i) => after.has(i.id) && !graph.deferred.has(i.id))
          .sort(byNumberAsc),
        kept: under.filter((i) => !after.has(i.id)).sort(byNumberAsc),
      };
    },
    resumption(number: number): Issue[] | undefined {
      const issue = byNumber.get(number);
      if (issue === undefined || set.gate === undefined) return undefined;
      const without = {
        issues: graph.issues,
        edges: graph.edges.filter(
          (e) =>
            !(e.issueId === issue.id && e.blockedById === set.gate!.id) &&
            !(e.issueId === set.later?.id && e.blockedById === issue.id),
        ),
      };
      const after = deferredIn(without, set.gate.id, set.later?.id);
      return [issue, ...[...beneath(issue.id)].map((id) => byId.get(id))]
        .filter(
          (i): i is Issue =>
            i !== undefined &&
            i.state === "open" &&
            graph.deferred.has(i.id) &&
            !after.has(i.id),
        )
        .sort((a, b) => a.number - b.number);
    },
    milestone(number: number): Milestone | undefined {
      const issue = byNumber.get(number);
      if (issue === undefined || !waits.has(issue.id)) return undefined;
      const limb = limbOf(issue);
      const under = [...beneath(issue.id)]
        .map((id) => byId.get(id))
        .filter((i): i is Issue => i !== undefined);
      const numbers = new Set(under.map((i) => i.number));
      const children = childrenOf(issue.id)
        .map((id) => byId.get(id))
        .filter((i): i is Issue => i !== undefined)
        .sort((a, b) => a.number - b.number);
      // A child is a limb when it brings a tree of its own; one that only
      // waits for its siblings is a leaf in an order.
      const siblings = new Set(children.map((c) => c.id));
      const isLimb = (child: Issue): boolean =>
        (waitsFor.get(child.id) ?? []).some((id) => !siblings.has(id));
      const closedThisWeek = under.filter(
        (i) =>
          i.state === "closed" && counted(i) && (i.closedAt ?? "") >= since,
      ).length;
      const { open } = limb.weight;
      const days =
        closedThisWeek === 0
          ? 0
          : Math.ceil(open / (closedThisWeek / PILLAR_DAYS));
      const estimate =
        limb.weight.total === 0
          ? "Nothing beneath it counts as work yet."
          : open === 0
            ? "Everything beneath it is done."
            : limb.deferred
              ? `Deferred${limb.deferredBecause === undefined ? "" : ` (${limb.deferredBecause})`}: the crew picks nothing beneath it until it is resumed, so there is no pace to estimate from.`
              : closedThisWeek === 0
              ? `Nothing closed here in ${PILLAR_DAYS} days, so there is no pace to estimate from.`
              : `About ${days} day${days === 1 ? "" : "s"} at this week's pace: ${closedThisWeek} closed in ${PILLAR_DAYS} days, ${open} open.`;
      const order: Record<LeafState, number> = {
        building: 0,
        proposed: 1,
        ready: 2,
        blocked: 3,
        deferred: 4,
        done: 5,
        gone: 6,
      };
      return {
        ...limb,
        building: under
          .filter((i) => i.state === "open" && building.has(i.id))
          .map((i) => ({ issue: i, ...building.get(i.id)! })),
        blocked: under
          .filter((i) => stateOf(i) === "blocked")
          .map((i) => ({
            issue: i,
            on: (waitsFor.get(i.id) ?? [])
              .map((id) => byId.get(id))
              .filter((b): b is Issue => b !== undefined && b.state === "open"),
          })),
        merged: merged
          .filter((pull) => pull.closes.some((n) => numbers.has(n)))
          .map(({ number: n, title, at }) => ({ number: n, title, at })),
        estimate,
        limbs: children.filter(isLimb).map(limbOf),
        leaves: children
          .filter((c) => !isLimb(c))
          .map((c) => {
            const state = stateOf(c);
            const why =
              state === "deferred" ? graph.deferred.get(c.id) : undefined;
            return { issue: c, state, ...(why === undefined ? {} : { why }) };
          })
          .sort(
            (a, b) =>
              order[a.state] - order[b.state] ||
              a.issue.number - b.issue.number,
          ),
      };
    },
  };
}

/** A weight as data: the same numbers the page shows. */
function weightJson(weight: Weight): Record<string, unknown> {
  return {
    done: weight.done,
    total: weight.total,
    open: weight.open,
    building: weight.building,
    mergedInDays: { days: PILLAR_DAYS, merged: weight.merged },
    lastMovement: weight.last,
    ...(weight.spentUsd === undefined ? {} : { spentUsd: weight.spentUsd }),
  };
}

/** A limb as data. */
export function limbJson(limb: Limb): Record<string, unknown> {
  return {
    number: limb.issue.number,
    name: limb.name,
    state: limb.issue.state,
    ...weightJson(limb.weight),
    deferred: limb.deferred,
    ...(limb.deferredBecause === undefined
      ? {}
      : { deferredBecause: limb.deferredBecause }),
    ...(limb.trim === undefined ? {} : { trim: limb.trim }),
  };
}

/**
 * One milestone as data. `names` says whether the caller may know who is
 * building: an agent's name is the owner's to see.
 */
export function milestoneJson(
  milestone: Milestone,
  names: boolean,
): Record<string, unknown> {
  const brief = (issue: Issue) => ({ number: issue.number, title: issue.title });
  return {
    ...limbJson(milestone),
    title: milestone.issue.title,
    estimate: milestone.estimate,
    // `building` is the count, as on a limb; this is who is on what.
    buildingNow: milestone.building.map((b) => ({
      ...brief(b.issue),
      who: names ? (b.who ?? "the crew") : "the crew",
      since: b.since,
    })),
    blocked: milestone.blocked.map((b) => ({
      ...brief(b.issue),
      on: b.on.map(brief),
    })),
    merged: milestone.merged,
    limbs: milestone.limbs.map(limbJson),
    leaves: milestone.leaves.map((leaf) => ({
      ...brief(leaf.issue),
      state: leaf.state,
      ...(leaf.why === undefined ? {} : { deferredBecause: leaf.why }),
    })),
  };
}
