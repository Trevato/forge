/**
 * Landing has stopped (#7790): the last {@link STOPPED_GATES} merge-queue
 * gates of a repository all went red for one cause and nothing has landed
 * since the first of them. "One cause" stands in for "one base" (a gate keeps
 * its candidate's tip, not its base): the three share a failing test, or all
 * failed with no test named and the same reason. Three unrelated broken pulls
 * fail different tests and do not make a stop. A bug in the gate itself looks
 * exactly so, and the gate cannot judge the pull that fixes it; the owner's way
 * past is `checks/bypass.ts`, offered only while this holds, and only for the
 * forge's own repository. Plain data: rows in, one record out.
 */

import type { Database } from "bun:sqlite";
import { getRepo } from "../core/repos.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";

/** How many gates in a row, red on one base, make landing stopped. */
export const STOPPED_GATES = 3;

export interface Stopped {
  /** When the earliest of the red gates finished. */
  readonly since: string;
  readonly gates: number;
}

/** The repository's stop, if its last gates are all red on a base nothing has landed on since. */
export function landingStopped(db: Database, repoId: string): Stopped | undefined {
  const gates = db
    .query<{ state: string; finished_at: string; reason: string | null; tests: string }, [string, number]>(
      "SELECT state, finished_at, reason, tests FROM gate_result WHERE repo_id = ?1 ORDER BY id DESC LIMIT ?2",
    )
    .all(repoId, STOPPED_GATES);
  if (gates.length < STOPPED_GATES || gates.some((g) => g.state !== "red")) return undefined;
  if (!oneCause(gates)) return undefined;
  const since = gates.reduce((a, g) => (g.finished_at < a ? g.finished_at : a), gates[0]!.finished_at);
  const landed = db
    .query<{ at: string | null }, [string]>(
      `SELECT MAX(p.merged_at) AS at FROM pull p JOIN issue i ON i.id = p.issue_id WHERE i.repo_id = ?1`,
    )
    .get(repoId);
  if (landed?.at != null && landed.at >= since) return undefined;
  return { since, gates: gates.length };
}

/** The failing test names a gate row kept; a row this build cannot read names none. */
function failingNames(tests: string): string[] {
  try {
    const list: unknown = JSON.parse(tests);
    if (!Array.isArray(list)) return [];
    return list.flatMap((t: unknown) =>
      typeof t === "object" && t !== null && typeof (t as { name?: unknown }).name === "string" ? [(t as { name: string }).name] : [],
    );
  } catch {
    return [];
  }
}

/** Whether the red gates share one cause: a failing test in all, or no test named and one reason. */
function oneCause(gates: readonly { reason: string | null; tests: string }[]): boolean {
  const names = gates.map((g) => new Set(failingNames(g.tests)));
  if (names.every((n) => n.size === 0)) return gates.every((g) => g.reason !== null && g.reason === gates[0]!.reason);
  return [...names[0]!].some((n) => names.every((set) => set.has(n)));
}

/** The stop, only for the forge's own repository: the one place the break-glass is offered. */
export function ownLandingStopped(db: Database, repo: { readonly id: string }): Stopped | undefined {
  const [owner, name] = ownRepoPath().split("/");
  const own = owner && name ? getRepo(db, owner, name) : undefined;
  if (own === undefined || own.id !== repo.id) return undefined;
  // Gate evidence only: the lane alarm (#11507) is a heuristic over merges and
  // run rows, and a merge drought with pulls waiting on review is not a red gate.
  return landingStopped(db, own.id);
}

/** The one sentence home and the pipeline carry. */
export const stoppedSentence = (s: Stopped): string =>
  `Landing has stopped: the last ${s.gates} gates were all red on the same base since ${s.since.slice(0, 16).replace("T", " ")} UTC, so no pull can pass; an owner can land one past the gate with a reason.`;
