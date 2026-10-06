/**
 * Issues that depend on issues. One row per edge, `issue` blocked by
 * `blocked_by`, both in the same repository. The map, the ready list, and
 * the crew's planner all read this table; nothing else remembers a plan.
 *
 * Everything here is a read or a single-row write. Rankings are computed on
 * demand from the whole graph of one repository, which is a few hundred
 * rows at most: a plan bigger than that is not a plan a person reads.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { getIssuesByIds, type CloseReason, type Issue } from "./issues.ts";
import { pillarsOf, structuralIds } from "./pillars.ts";
import { getRepoById } from "./repos.ts";
import { unadoptedAmong } from "../crew/direct.ts";

export type DependencyError = "self" | "cross_repo" | "cycle" | "not_an_issue";

export interface Edge {
  /** The issue that waits. */
  readonly issueId: string;
  /** The issue it waits for. */
  readonly blockedById: string;
}

/**
 * Link `issue` as blocked by `blocker`. Refused when it would close a loop:
 * a plan with a cycle has no first step, and the map would have nowhere to
 * start it. Linking twice is not an error; the edge simply exists — and
 * when `restate` is set (a person who writes here linked it), it is theirs
 * from now on, which is what adopts a reader's issue (`crew/direct.ts`).
 */
export function addDependency(
  db: Database,
  issue: Issue,
  blocker: Issue,
  actorId: string | undefined,
  restate = false,
): Result<void, DependencyError> {
  if (issue.id === blocker.id) return err("self");
  if (issue.repoId !== blocker.repoId) return err("cross_repo");
  if (issue.kind !== "issue" || blocker.kind !== "issue")
    return err("not_an_issue");
  if (reaches(db, blocker.id, issue.id)) return err("cycle");
  db.query(
    `INSERT INTO issue_dependency (issue_id, blocked_by_id, actor_id)
     VALUES (?1, ?2, ?3)
     ON CONFLICT DO ${restate ? "UPDATE SET actor_id = excluded.actor_id" : "NOTHING"}`,
  ).run(issue.id, blocker.id, actorId ?? null);
  return ok(undefined);
}

export function removeDependency(
  db: Database,
  issueId: string,
  blockedById: string,
): boolean {
  return (
    db
      .query(
        "DELETE FROM issue_dependency WHERE issue_id = ?1 AND blocked_by_id = ?2",
      )
      .run(issueId, blockedById).changes > 0
  );
}

/**
 * A person says the plan still holds: `issue` may go ahead although its
 * blocker closed as dropped or split. Returns whether an edge was changed.
 */
export function confirmDependency(
  db: Database,
  issueId: string,
  blockedById: string,
): boolean {
  return (
    db
      .query(
        `UPDATE issue_dependency SET confirmed = 1
         WHERE issue_id = ?1 AND blocked_by_id = ?2 AND confirmed = 0`,
      )
      .run(issueId, blockedById).changes > 0
  );
}

/**
 * `parent` was split into `children`: what it waited for, they wait for, and
 * it waits for nothing. A child that would close a loop is left out of that
 * edge. Returns how many edges were moved.
 */
export function moveBlockersToChildren(
  db: Database,
  parent: Issue,
  children: readonly Issue[],
  actorId: string | undefined,
): number {
  const blockers = getIssuesByIds(db, blockerIds(db, parent.id));
  let moved = 0;
  for (const blocker of blockers.values())
    for (const child of children)
      if (addDependency(db, child, blocker, actorId).ok) moved++;
  db.query("DELETE FROM issue_dependency WHERE issue_id = ?1").run(parent.id);
  return moved;
}

/** Whether `from` is blocked, directly or through others, by `to`. */
function reaches(db: Database, from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of blockerIds(db, current)) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function blockerIds(db: Database, issueId: string): string[] {
  return db
    .query<{ blocked_by_id: string }, [string]>(
      "SELECT blocked_by_id FROM issue_dependency WHERE issue_id = ?1",
    )
    .all(issueId)
    .map((r) => r.blocked_by_id);
}

/**
 * The numbers each issue waits for, for a batch of issues in one query per
 * chunk, ascending. Only ids that wait for something get an entry.
 */
export function blockerNumbersFor(
  db: Database,
  issueIds: readonly string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const CHUNK = 500;
  for (let i = 0; i < issueIds.length; i += CHUNK) {
    const chunk = issueIds.slice(i, i + CHUNK);
    const rows = db
      .query<{ issue_id: string; number: number }, string[]>(
        `SELECT d.issue_id, b.number FROM issue_dependency AS d
         JOIN issue AS b ON b.id = d.blocked_by_id
         WHERE d.issue_id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})
         ORDER BY b.number`,
      )
      .all(...chunk);
    for (const row of rows) {
      const list = out.get(row.issue_id) ?? [];
      list.push(row.number);
      out.set(row.issue_id, list);
    }
  }
  return out;
}

/** What this issue waits for, and what waits for it. */
export function dependenciesOf(
  db: Database,
  issueId: string,
): { blockedBy: Issue[]; blocks: Issue[] } {
  const blockedBy = blockerIds(db, issueId);
  const blocks = db
    .query<{ issue_id: string }, [string]>(
      "SELECT issue_id FROM issue_dependency WHERE blocked_by_id = ?1",
    )
    .all(issueId)
    .map((r) => r.issue_id);
  const issues = getIssuesByIds(db, [...blockedBy, ...blocks]);
  const pick = (ids: string[]) =>
    ids
      .map((id) => issues.get(id))
      .filter((i): i is Issue => i !== undefined)
      .sort((a, b) => a.number - b.number);
  return { blockedBy: pick(blockedBy), blocks: pick(blocks) };
}

// ---- the graph of one repository ----

/** An open issue held by a blocker that closed without being done. */
export interface Held {
  readonly issueId: string;
  readonly blockedById: string;
  readonly reason: Exclude<CloseReason, "done">;
}

export interface Graph {
  /** Every issue of kind `issue` that is open or on an edge. */
  readonly issues: Issue[];
  readonly edges: Edge[];
  /**
   * Edges whose blocker closed as dropped or split and that no person has
   * confirmed or relinked: closing frees only what was done.
   */
  readonly held: Held[];
  /**
   * Open issues a reader opened that no one who may direct the crew has
   * adopted (`crew/direct.ts`): on the map, never ready for the crew.
   */
  readonly unadopted: ReadonlySet<string>;
  /**
   * The plan's own furniture (`pillars.ts`): each pillar's umbrella, the
   * Later umbrella and the Later gate. They say what the work is for and
   * are never work themselves, so never ready.
   */
  readonly structural: ReadonlySet<string>;
}

const GRAPH_MAX = 400;

export function repoGraph(
  db: Database,
  repoId: string,
  /** Include sealed issues (`sealed.ts`): for a viewer who may see them, and the crew. */
  options: { readonly sealed?: boolean } = {},
): Graph {
  const edges = db
    .query<{ issue_id: string; blocked_by_id: string }, [string]>(
      `SELECT d.issue_id, d.blocked_by_id FROM issue_dependency d
         JOIN issue i ON i.id = d.issue_id WHERE i.repo_id = ?1`,
    )
    .all(repoId)
    .map((r) => ({ issueId: r.issue_id, blockedById: r.blocked_by_id }));
  const heldRows = db
    .query<
      { issue_id: string; blocked_by_id: string; reason: Held["reason"] },
      [string]
    >(
      `SELECT d.issue_id, d.blocked_by_id, b.close_reason AS reason
         FROM issue_dependency d
         JOIN issue i ON i.id = d.issue_id AND i.state = 'open'
         JOIN issue b ON b.id = d.blocked_by_id AND b.state = 'closed'
        WHERE i.repo_id = ?1 AND d.confirmed = 0
          AND b.close_reason IN ('dropped','split')
        ORDER BY b.number`,
    )
    .all(repoId);
  const open = db
    .query<{ id: string }, [string, number]>(
      `SELECT id FROM issue WHERE repo_id = ?1 AND kind = 'issue' AND state = 'open'
       ORDER BY number LIMIT ?2`,
    )
    .all(repoId, GRAPH_MAX)
    .map((r) => r.id);
  const ids = new Set<string>(open);
  for (const e of edges) {
    ids.add(e.issueId);
    ids.add(e.blockedById);
  }
  const issues = [...getIssuesByIds(db, [...ids]).values()]
    .filter((i) => options.sealed === true || !i.sealed)
    .sort((a, b) => a.number - b.number);
  const present = new Set(issues.map((i) => i.id));
  const repo = getRepoById(db, repoId);
  return {
    issues,
    unadopted:
      repo === undefined ? new Set() : unadoptedAmong(db, repo, issues),
    structural:
      repo === undefined ? new Set() : structuralIds(pillarsOf(db, repo)),
    edges: edges.filter(
      (e) => present.has(e.issueId) && present.has(e.blockedById),
    ),
    held: heldRows
      .filter((r) => present.has(r.issue_id) && present.has(r.blocked_by_id))
      .map((r) => ({
        issueId: r.issue_id,
        blockedById: r.blocked_by_id,
        reason: r.reason,
      })),
  };
}

// ---- rankings, all from one graph ----

export interface Ranked {
  readonly issue: Issue;
  /** Open issues this one holds up, transitively. */
  readonly holdsUp: number;
  /** Open issues this one waits for, transitively. */
  readonly waitsFor: number;
}

function openIds(graph: Graph): Set<string> {
  return new Set(
    graph.issues.filter((i) => i.state === "open").map((i) => i.id),
  );
}

/** For each issue, the set of open issues it transitively holds up. */
function holdsUpMap(graph: Graph, open: Set<string>): Map<string, Set<string>> {
  const dependents = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = dependents.get(e.blockedById) ?? [];
    list.push(e.issueId);
    dependents.set(e.blockedById, list);
  }
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const walk = (id: string): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const out = new Set<string>();
    for (const d of dependents.get(id) ?? []) {
      if (open.has(d)) out.add(d);
      for (const x of walk(d)) out.add(x);
    }
    visiting.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const i of graph.issues) walk(i.id);
  return memo;
}

/** For each issue, the set of open issues it transitively waits for. */
function waitsForMap(
  graph: Graph,
  open: Set<string>,
): Map<string, Set<string>> {
  const blockers = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = blockers.get(e.issueId) ?? [];
    list.push(e.blockedById);
    blockers.set(e.issueId, list);
  }
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const walk = (id: string): Set<string> => {
    const known = memo.get(id);
    if (known) return known;
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const out = new Set<string>();
    for (const b of blockers.get(id) ?? []) {
      if (open.has(b)) out.add(b);
      for (const x of walk(b)) out.add(x);
    }
    visiting.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const i of graph.issues) walk(i.id);
  return memo;
}

/** Open issues nothing open stands in front of, whoever they are for, in the ready order. */
function clearNow(graph: Graph): Ranked[] {
  const open = openIds(graph);
  const holds = holdsUpMap(graph, open);
  const waits = waitsForMap(graph, open);
  const held = new Set(graph.held.map((h) => h.issueId));
  return graph.issues
    .filter(
      (i) =>
        open.has(i.id) &&
        !held.has(i.id) &&
        (waits.get(i.id)?.size ?? 0) === 0,
    )
    .map((issue) => ({
      issue,
      holdsUp: holds.get(issue.id)?.size ?? 0,
      waitsFor: 0,
    }))
    .sort(
      (a, b) =>
        b.holdsUp - a.holdsUp ||
        a.issue.createdAt.localeCompare(b.issue.createdAt),
    );
}

/**
 * Open issues nothing open stands in front of, first the ones whose finishing
 * frees the most, then the oldest — a reader's suggestion only once someone
 * who writes here adopted it, and never the plan's own furniture: an
 * umbrella or the Later gate is not work. What a free crew slot takes next.
 */
export function readyNow(graph: Graph): Ranked[] {
  return clearNow(graph).filter(
    (r) =>
      !graph.unadopted.has(r.issue.id) && !graph.structural.has(r.issue.id),
  );
}

/**
 * The plan's furniture that nothing open stands in front of: an umbrella
 * whose work is done, or one nothing serves yet. A person's to close; the
 * map says so rather than calling it ready.
 */
export function idleFurniture(graph: Graph): Issue[] {
  return clearNow(graph)
    .filter((r) => graph.structural.has(r.issue.id))
    .map((r) => r.issue);
}

/** Open issues that hold others up, the widest blockage first. */
export function blockedOn(graph: Graph): Ranked[] {
  const open = openIds(graph);
  const holds = holdsUpMap(graph, open);
  const waits = waitsForMap(graph, open);
  return graph.issues
    .filter((i) => open.has(i.id) && (holds.get(i.id)?.size ?? 0) > 0)
    .map((issue) => ({
      issue,
      holdsUp: holds.get(issue.id)?.size ?? 0,
      waitsFor: waits.get(issue.id)?.size ?? 0,
    }))
    .sort((a, b) => b.holdsUp - a.holdsUp || a.issue.number - b.issue.number);
}

/**
 * The longest chain of open issues, blocker to blocked: the least work that
 * still has to happen one thing after another. Cycles are stepped over, not
 * followed.
 */
export function criticalPath(graph: Graph): Issue[] {
  const open = openIds(graph);
  const blockers = new Map<string, string[]>();
  for (const e of graph.edges)
    if (open.has(e.issueId) && open.has(e.blockedById)) {
      const list = blockers.get(e.issueId) ?? [];
      list.push(e.blockedById);
      blockers.set(e.issueId, list);
    }
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const memo = new Map<string, string[]>();
  const visiting = new Set<string>();
  const longest = (id: string): string[] => {
    const known = memo.get(id);
    if (known) return known;
    if (visiting.has(id)) return [id];
    visiting.add(id);
    let best: string[] = [];
    for (const b of blockers.get(id) ?? []) {
      const chain = longest(b);
      if (chain.length > best.length) best = chain;
    }
    visiting.delete(id);
    const out = [...best, id];
    memo.set(id, out);
    return out;
  };
  let best: string[] = [];
  for (const id of open) {
    const chain = longest(id);
    if (chain.length > best.length) best = chain;
  }
  return best.length > 1
    ? best.map((id) => byId.get(id)).filter((i): i is Issue => i !== undefined)
    : [];
}

// ---- level and flow ----

export interface DayPoint {
  readonly day: string;
  /** Open issues at the end of that day: the level. */
  readonly open: number;
  /** Issues closed during that day: the flow. */
  readonly closed: number;
}

/** The last `days` days of open count against closed-per-day, oldest first. */
export function levelAndFlow(
  db: Database,
  repoId: string,
  days = 14,
  now = new Date(),
): DayPoint[] {
  const out: DayPoint[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const end = new Date(now);
    end.setUTCHours(24, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() - back);
    const endIso = end.toISOString();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 1);
    const startIso = start.toISOString();
    const open = db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'issue'
           AND created_at < ?2 AND (closed_at IS NULL OR closed_at >= ?2)`,
      )
      .get(repoId, endIso)!.n;
    const closed = db
      .query<{ n: number }, [string, string, string]>(
        `SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'issue'
           AND closed_at >= ?2 AND closed_at < ?3`,
      )
      .get(repoId, startIso, endIso)!.n;
    out.push({ day: startIso.slice(0, 10), open, closed });
  }
  return out;
}
