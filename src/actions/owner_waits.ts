/**
 * What an app's crew waits on its owner for, as plain data: the planner that
 * declined the direction, and the agent pulls that wait for a person's
 * review. The board's notes and the terminal's first screen both read it,
 * so the two doors say the same things. Owner facts only: the caller passes
 * the repositories whose owner facts the viewer may see.
 */

import { getIssuesByIds, type Issue } from "../core/issues.ts";
import { joinMany } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { plannerDeclines } from "../crew/autonomy.ts";
import { reviewerPaused } from "../crew/reviewer_paused.ts";
import { reviewersOf, waitsForPerson } from "../crew/review.ts";
import type { Database } from "bun:sqlite";

export type OwnerWait =
  | { kind: "declined"; repo: Repo; issue: Issue; runId: string }
  | { kind: "review"; repo: Repo; none: boolean; paused: boolean; waiting: number; since: string | null };

/** The planner declines among these repositories, one per app. */
export function declinedWaits(db: Database, repos: readonly Repo[]): OwnerWait[] {
  return plannerDeclines(db, repos).map((d) => ({
    kind: "declined",
    repo: d.repo,
    issue: d.issue,
    runId: d.runId,
  }));
}

/**
 * One wait per autonomous app whose agent pulls wait for a person's review
 * (#597), or whose crew has no reviewer; none when nothing waits and every
 * such app has its reviewer.
 */
export function reviewWaits(db: Database, repos: readonly Repo[]): OwnerWait[] {
  const auto = repos.filter((r) => r.autonomy === "autonomous");
  if (auto.length === 0) return [];
  const ids = db
    .query<{ id: string }, string[]>(
      `SELECT issue.id AS id FROM issue JOIN user ON user.id = issue.author_id
       WHERE issue.kind = 'pull' AND issue.state = 'open' AND user.is_agent = 1
         AND issue.repo_id IN (${auto.map((_, i) => `?${i + 1}`).join(",")})`,
    )
    .all(...auto.map((r) => r.id))
    .map((r) => r.id);
  const pulls = joinMany(db, [...getIssuesByIds(db, ids).values()]);
  return auto.flatMap((repo): OwnerWait[] => {
    const waits = pulls
      .filter((p) => p.repoId === repo.id)
      .flatMap((p) => {
        const w = waitsForPerson(db, repo.id, p);
        return w === undefined ? [] : [w];
      });
    const paused = reviewerPaused(repo);
    const none = reviewersOf(db, repo.id).length === 0;
    if (!none && !paused && waits.length === 0) return [];
    return [
      { kind: "review", repo, none, paused, waiting: waits.length, since: waits.map((w) => w.since).sort()[0] ?? null },
    ];
  });
}

/** Both kinds for these repositories. */
export function ownerWaits(db: Database, repos: readonly Repo[]): OwnerWait[] {
  return [...declinedWaits(db, repos), ...reviewWaits(db, repos)];
}

/** One plain line, for the terminal. */
export function waitLine(w: OwnerWait): string {
  if (w.kind === "declined")
    return `${w.repo.name}: the planner declined the direction and waits for you (issue #${w.issue.number})`;
  return `${w.repo.name}: ${w.none ? "no reviewer: agent pulls wait for you" : w.paused ? "the reviewer is paused: agent pulls wait for you" : "agent pulls wait for your review"}${
    w.waiting === 0 || w.since === null ? "" : ` · ${w.waiting} waiting since ${w.since.slice(0, 10)}`
  }`;
}

/** The first `n` lines, then "+N more" when some were left out. */
export function withMore(lines: readonly string[], n: number): string[] {
  return lines.length <= n ? [...lines] : [...lines.slice(0, n), `+${lines.length - n} more`];
}
