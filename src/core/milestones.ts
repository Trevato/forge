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

import { paceOf, type Pace } from "./pace.ts";
import type { Database } from "bun:sqlite";
import { writeStamp } from "./write_clock.ts";
import { deferredIn, repoGraph, type Graph } from "./dependencies.ts";
import {
  limbTree,
  readPlaces,
  seated,
  TOP,
  type LimbTree,
  type Places,
} from "./limb_order.ts";
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

/** How many issues a milestone's spend names. */
export const COSTLIEST = 3;

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
  /**
   * What the limb cost and landed, ever: owner facts only, so nothing for a
   * viewer who may not see them. `costliest` is at most `COSTLIEST` issues
   * beneath it, dearest first; an issue that cost nothing is not listed.
   */
  readonly spend?: {
    readonly usd: number;
    /** Pulls merged, ever, for the issues beneath it. */
    readonly landed: number;
    readonly costliest: readonly { readonly issue: Issue; readonly usd: number }[];
  };
  /** A plain sentence: when it lands at this week's pace, or why nobody can say. */
  readonly estimate: string;
  /** Issues closed per day and the date it is on pace for, at the `now` the plan was read with. */
  readonly pace: Pace;
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
  /** What the plan was read from, for a caller that asks more of the same graph. */
  readonly read: { readonly graph: Graph; readonly tree: LimbTree; readonly places: Places };
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
 * What `readPlan` reads of one repository, as a string that moves when any
 * of it does: its issues and pulls, their dependencies, the runs on it (a
 * start, a finish, a cost) and where limbs are placed. Equal strings mean
 * the same plan. Another repository's writes do not move it. Undefined
 * inside a transaction: nothing is kept that a rollback could outlive.
 */
export function planStamp(db: Database, repo: Repo): string | undefined {
  const clock = writeStamp(db);
  if (clock === undefined) return undefined;
  let kept = stamps.get(db);
  if (kept === undefined) stamps.set(db, (kept = new Map()));
  const known = kept.get(repo.id);
  if (known?.clock === clock) return known.stamp;
  const stamp = readStamp(db, repo);
  if (kept.size >= STAMPS_KEPT) kept.clear();
  kept.set(repo.id, { clock, stamp });
  return stamp;
}

/** The stamp last read for each repository, and the write clock it was read at: nothing written since means nothing to read again. */
const stamps = new WeakMap<Database, Map<string, { clock: string; stamp: string }>>();
const STAMPS_KEPT = 200;

function readStamp(db: Database, repo: Repo): string {
  const one = (sql: string): string =>
    JSON.stringify(Object.values(db.query<Record<string, unknown>, [string]>(sql).get(repo.id) ?? {}));
  return [
    one(`SELECT COUNT(*), SUM(state = 'open'), MAX(updated_at), MAX(closed_at), SUM(length(title)), SUM(sealed), SUM(parked), COUNT(close_reason), COUNT(assignee_id) FROM issue WHERE repo_id = ?1`),
    one(`SELECT COUNT(*), MAX(d.created_at), SUM(d.confirmed) FROM issue_dependency d JOIN issue i ON i.id = d.issue_id WHERE i.repo_id = ?1`),
    one(`SELECT COUNT(*), MAX(p.merged_at) FROM pull p JOIN issue i ON i.id = p.issue_id WHERE i.repo_id = ?1`),
    one(`SELECT COUNT(*), SUM(state IN ('queued','running')), SUM(cost_usd), MAX(started_at), MAX(finished_at) FROM run WHERE repo_id = ?1 AND kind = 'agent'`),
    one(`SELECT COUNT(*), SUM(place), SUM(rowid) FROM limb_place WHERE repo_id = ?1`),
  ].join("|");
}

/**
 * Read one repository's plan as milestones. `spend` adds what each limb
 * cost, for a viewer who may see owner facts — the caller decides.
 */
export function readPlan(
  db: Database,
  repo: Repo,
  options: {
    readonly spend: boolean;
    readonly now?: Date;
    /** Told how long each stretch took (`graph`, `crew`, `week`, `spend`, `limbs`), for Server-Timing. */
    readonly stretch?: (name: string, ms: number) => void;
  } = { spend: false },
): Plan {
  const now = options.now ?? new Date();
  const since = pillarWindowStart(now);
  let mark = performance.now();
  const lap = (name: string): void => {
    const at = performance.now();
    options.stretch?.(name, at - mark);
    mark = at;
  };
  const set: Pillars = pillarsOf(db, repo);
  const graph: Graph = repoGraph(db, repo.id, { pillars: set, lean: true });
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const byNumber = new Map(graph.issues.map((i) => [i.number, i]));

  // What each issue waits for directly, furniture left out (`limb_order.ts`).
  const tree = limbTree(graph, set);
  const places = readPlaces(db, repo.id);
  lap("graph");
  const { waitsFor, waitedBy, waits, childrenOf } = tree;
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
  /** Sibling limbs as issues, in the order a person set. */
  const arranged = (group: string, ids: readonly string[]): Issue[] =>
    seated(places, group, ids)
      .map((id) => byId.get(id))
      .filter((i): i is Issue => i !== undefined);

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

  lap("crew");

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

  lap("week");

  // What each issue cost: its own runs, and the runs on the pulls for it.
  const cost = new Map<string, number>();
  if (options.spend) {
    const rows = db
      .query<{ id: string; kind: string; body: string; usd: number }, [string]>(
        `SELECT i.id, i.kind, CASE i.kind WHEN 'pull' THEN i.body ELSE '' END AS body, SUM(r.cost_usd) AS usd
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

  // Every pull ever merged, by the issues it closes: what a limb landed.
  // One query that parses each merged pull's body; owner reads only, and
  // only one milestone's page asks, so the list of limbs never pays for it.
  let ever: (readonly number[])[] | undefined;
  const everMerged = (): (readonly number[])[] =>
    (ever ??= db
      .query<{ body: string }, [string]>(
        `SELECT i.body FROM pull p JOIN issue i ON i.id = p.issue_id
          WHERE i.repo_id = ?1 AND p.merged_at IS NOT NULL`,
      )
      .all(repo.id)
      .map((row) => closesFromBody(row.body)));

  lap("spend");

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

  const top = arranged(
    TOP,
    tree.top.map((i) => i.id),
  );

  const limbs = top.map(limbOf);
  lap("limbs");

  return {
    read: { graph, tree, places },
    limbs,
    limb(number: number): { own: Issue[]; shared: Issue[] } | undefined {
      const issue = byNumber.get(number);
      if (issue === undefined) return undefined;
      const found = [issue.id];
      const inside = new Set(found);
      for (let n = 0; n < found.length; n++)
        for (const child of waitsFor.get(found[n]!) ?? [])
          if (!inside.has(child)) {
            inside.add(child);
            found.push(child);
          }
      // Top down means every issue before what it waits for — siblings
      // included, so an order among them holds — and leaves first is the
      // same list read backwards. Kahn's walk, ties by number.
      const waitedIn = new Map<string, number>();
      for (const id of inside)
        for (const child of waitsFor.get(id) ?? [])
          if (inside.has(child))
            waitedIn.set(child, (waitedIn.get(child) ?? 0) + 1);
      const byNumberAsc = (a: string, b: string) =>
        (byId.get(a)?.number ?? 0) - (byId.get(b)?.number ?? 0);
      const order: string[] = [];
      let free = found.filter((id) => (waitedIn.get(id) ?? 0) === 0).sort(byNumberAsc);
      const placed = new Set<string>();
      while (free.length > 0) {
        const next = free.shift()!;
        order.push(next);
        placed.add(next);
        for (const child of waitsFor.get(next) ?? []) {
          if (!inside.has(child)) continue;
          const left = (waitedIn.get(child) ?? 0) - 1;
          waitedIn.set(child, left);
          if (left === 0) free = [...free, child].sort(byNumberAsc);
        }
      }
      for (const id of found) if (!placed.has(id)) order.push(id);
      // Shared: other open work outside the limb waits for it, directly or
      // through something beneath the limb that is itself shared. An
      // umbrella's wait is membership, not need: on a plan where every
      // issue is linked under its pillar, a leaf is still the limb's own.
      const shared = new Set<string>();
      for (let grew = true; grew; ) {
        grew = false;
        for (const id of order) {
          if (id === issue.id || shared.has(id)) continue;
          const needed = (waitedBy.get(id) ?? []).some(
            (w) =>
              byId.get(w)?.state === "open" &&
              !isStructural(set, w) &&
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
      const limb = this.limb(number);
      if (limb === undefined || set.gate === undefined) return undefined;
      // Every open issue of the limb's own is filed for later, and anything
      // else that then only deferred work needs follows by the rule.
      const own = limb.own.filter((i) => i.state === "open");
      const after = deferredIn(
        graph,
        set.gate.id,
        set.later?.id,
        own.map((i) => i.id),
      );
      const byNumberAsc = (a: Issue, b: Issue) => a.number - b.number;
      return {
        taken: graph.issues
          .filter(
            (i) =>
              i.state === "open" &&
              after.has(i.id) &&
              !graph.deferred.has(i.id) &&
              !isStructural(set, i.id),
          )
          .sort(byNumberAsc),
        kept: limb.shared.filter((i) => i.state === "open").sort(byNumberAsc),
      };
    },
    resumption(number: number): Issue[] | undefined {
      const limb = this.limb(number);
      if (limb === undefined || set.gate === undefined) return undefined;
      // What is the limb's own and deferred now: it can be picked again.
      return limb.own
        .filter((i) => i.state === "open" && graph.deferred.has(i.id))
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
      const limbIds = new Set(tree.limbsOf(issue.id));
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
        ...(options.spend
          ? {
              spend: {
                usd: limb.weight.spentUsd ?? 0,
                landed: everMerged().filter((closes) =>
                  closes.some((n) => numbers.has(n)),
                ).length,
                costliest: under
                  .filter((i) => (cost.get(i.id) ?? 0) > 0)
                  .map((i) => ({ issue: i, usd: cost.get(i.id)! }))
                  .sort((a, b) => b.usd - a.usd || a.issue.number - b.issue.number)
                  .slice(0, COSTLIEST),
              },
            }
          : {}),
        estimate,
        pace: paceOf(
          {
            closedAt: under
              .filter((i) => i.state === "closed" && counted(i) && i.closedAt !== null)
              .map((i) => i.closedAt!),
            total: limb.weight.total,
            open,
            deferred: limb.deferred,
            closedInWindow: closedThisWeek,
            window: PILLAR_DAYS,
            days,
          },
          now,
        ),
        limbs: arranged(issue.id, [...limbIds]).map(limbOf),
        leaves: children
          .filter((c) => !limbIds.has(c.id))
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
    closedPerDay: milestone.pace.closedPerDay,
    paceDate: milestone.pace.paceDate,
    pace: milestone.pace.line,
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
    ...(milestone.spend === undefined
      ? {}
      : {
          spend: {
            usd: milestone.spend.usd,
            landed: milestone.spend.landed,
            costliest: milestone.spend.costliest.map((c) => ({
              ...brief(c.issue),
              usd: c.usd,
            })),
          },
        }),
    limbs: milestone.limbs.map(limbJson),
    leaves: milestone.leaves.map((leaf) => ({
      ...brief(leaf.issue),
      state: leaf.state,
      ...(leaf.why === undefined ? {} : { deferredBecause: leaf.why }),
    })),
  };
}
