/**
 * Quiet runs: an agent run that finished without failing and left nothing
 * behind — no push (to the repository or the agent's fork), no pull, no comment, no issue — is noise above the posts
 * that matter. The run's own record says so: its agent, and the window it
 * worked in, against what that agent wrote to the repository in that window.
 * A run the record cannot find is never called quiet.
 */

import type { Database } from "bun:sqlite";
import type { ForgeEvent } from "../core/events.ts";
import { getForkOf } from "../core/repos.ts";
import { getRunsByIds } from "../core/runs.ts";

/** What an agent leaves behind that is worth a post of its own. */
const LEFT_BEHIND = [
  "push",
  "pull.opened",
  "pull.commented",
  "pull.reviewed",
  "pull.merged",
  "issue.opened",
  "issue.commented",
];

/** How far back the feed counts quiet runs. */
export const QUIET_WINDOW_MS = 24 * 60 * 60 * 1000;

const ids = (value: unknown): string => (typeof value === "string" ? value : "");

/** Of these `run.finished` events, the ids of those that were quiet runs. */
export function quietRunEventIds(
  db: Database,
  finished: readonly ForgeEvent[],
): Set<string> {
  const candidates = finished.filter(
    (e) =>
      e.kind === "run.finished" &&
      e.payload["state"] !== "failed" &&
      e.payload["kind"] === "agent" &&
      ids(e.payload["runId"]) !== "",
  );
  const runs = getRunsByIds(
    db,
    candidates.map((e) => ids(e.payload["runId"])),
  );
  const marks = LEFT_BEHIND.map((_, n) => `?${n + 5}`).join(",");
  const left = db.query<{ one: number }, (string | null)[]>(
    `SELECT 1 AS one FROM event
      WHERE repo_id IN (?1, ?2) AND actor_id = ?3 AND created_at >= ?4
        AND kind IN (${marks}) AND created_at <= ?${LEFT_BEHIND.length + 5} LIMIT 1`,
  );
  const quiet = new Set<string>();
  const forks = new Map<string, string>();
  for (const e of candidates) {
    const run = runs.get(ids(e.payload["runId"]));
    if (
      run === undefined ||
      run.kind !== "agent" ||
      run.state === "failed" ||
      run.actorId === null ||
      run.startedAt === null ||
      run.finishedAt === null
    )
      continue;
    // Crew agents push to their own fork of the repository, not to it.
    const forkKey = `${run.actorId}|${run.repoId}`;
    if (!forks.has(forkKey))
      forks.set(forkKey, getForkOf(db, run.actorId, run.repoId)?.id ?? run.repoId);
    const wrote = left.get(
      run.repoId,
      forks.get(forkKey)!,
      run.actorId,
      run.startedAt,
      ...LEFT_BEHIND,
      run.finishedAt,
    );
    if (wrote === null) quiet.add(e.id);
  }
  return quiet;
}
