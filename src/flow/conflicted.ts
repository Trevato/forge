/**
 * Pulls that main moved out from under (#2039): open pulls with a
 * bring-up-to-date run queued, running or failed, by how long since the
 * crew was first asked to bring each one up to date. Read from the runs
 * alone, so /flow, the terminal and MCP say the same without asking git —
 * and the approved pulls the finishing pass last found conflicted and
 * still waiting for room, which have no run yet (#6140).
 */

import type { Database } from "bun:sqlite";
import { readConflictLane } from "../crew/conflict_room.ts";
import { span } from "./pipeline.ts";

export interface ConflictedPull {
  readonly repo: string;
  readonly number: number;
  /** When the crew was first asked to bring it up to date. */
  readonly since: string;
}

/** An approved pull the finishing pass found conflicted, with no run on it yet. */
export interface WaitingToFinish extends ConflictedPull {
  readonly public: boolean;
}

/** Per database: repository id → its approved, conflicted pulls on the finishing pass's last tick. */
const waiting = new WeakMap<Database, Map<string, readonly WaitingToFinish[]>>();

/** What the finishing pass found this tick in one repository; a pull seen before keeps its first `since`. */
export function noteWaitingToFinish(
  db: Database,
  repoId: string,
  pulls: readonly WaitingToFinish[],
): void {
  let mine = waiting.get(db);
  if (!mine) waiting.set(db, (mine = new Map()));
  const before = new Map((mine.get(repoId) ?? []).map((p) => [p.number, p.since]));
  if (pulls.length === 0) mine.delete(repoId);
  else mine.set(repoId, pulls.map((p) => ({ ...p, since: before.get(p.number) ?? p.since })));
}

/** Oldest first; `publicOnly` leaves out private repositories, for a reader who must not learn their names. */
export function conflictedPulls(db: Database, publicOnly = false): ConflictedPull[] {
  const ran = conflictRuns(db, publicOnly);
  const seen = new Set(ran.map((p) => `${p.repo}#${p.number}`));
  const noted = [...(waiting.get(db)?.values() ?? [])]
    .flat()
    .filter((p) => (!publicOnly || p.public) && !seen.has(`${p.repo}#${p.number}`))
    .map(({ repo, number, since }) => ({ repo, number, since }));
  return noted.length === 0 ? ran : [...ran, ...noted].sort((a, b) => a.since.localeCompare(b.since));
}

function conflictRuns(db: Database, publicOnly: boolean): ConflictedPull[] {
  return db
    .query<ConflictedPull, [number]>(
      `SELECT o.username || '/' || r.name AS repo, i.number AS number,
              MIN(u.created_at) AS since
         FROM run u INDEXED BY run_conflict CROSS JOIN issue i ON i.id = u.issue_id
         JOIN pull p ON p.issue_id = i.id JOIN repo r ON r.id = i.repo_id JOIN user o ON o.id = r.owner_id
        WHERE u.kind = 'agent' AND u.reason = 'conflict' AND i.state = 'open'
          AND p.merged_at IS NULL AND (?1 = 0 OR r.visibility = 'public')
          AND (SELECT state FROM run n WHERE n.issue_id = i.id AND n.kind = 'agent'
                  AND n.reason = 'conflict' ORDER BY n.created_at DESC, n.id DESC LIMIT 1)
              IN ('queued','running','failed')
        GROUP BY i.id ORDER BY since`,
    )
    .all(publicOnly ? 1 : 0);
}

/** One sentence for /flow, or null when none is conflicted. */
export function conflictedSays(
  pulls: readonly ConflictedPull[],
  now = Date.now(),
): string | null {
  if (pulls.length === 0) return null;
  const list = pulls
    .slice(0, 5)
    .map((p) => `${p.repo}#${p.number} ${span(now - Date.parse(p.since))}`)
    .join(", ");
  const more = pulls.length > 5 ? `, and ${pulls.length - 5} more` : "";
  return `${pulls.length} conflicted ${pulls.length === 1 ? "pull" : "pulls"}, oldest first: ${list}${more}.`;
}

/** The lane for rebases: conflicted pulls, how many are being brought up to date, and the room for more (#6140). */
export interface RebaseLane {
  readonly conflicted: number;
  /** Bring-up-to-date runs and their checks, queued or running, forge-wide. */
  readonly rebasing: number;
  /** Bring-up-to-date runs the lane has room to start now (`crew/conflict_room.ts`). */
  readonly room: number;
}

export function rebaseLane(db: Database, pulls: readonly ConflictedPull[]): RebaseLane {
  const lane = readConflictLane(db);
  return { conflicted: pulls.length, rebasing: lane.runs + lane.checks, room: lane.room };
}

/** `conflicted N, rebasing M, room R`, so a stall reads in a minute; null when nothing is conflicted or rebasing. */
export function rebaseLaneSays(lane: RebaseLane): string | null {
  if (lane.conflicted === 0 && lane.rebasing === 0) return null;
  return `conflicted ${lane.conflicted}, rebasing ${lane.rebasing}, room ${lane.room}`;
}

/** The finishing pass's last findings as plain data, and their adoption by a thread that does not make them (`engine/observed.ts`). */
export const observedWaiting = (db: Database): Map<string, unknown> => new Map(waiting.get(db) ?? []);
export function adoptWaiting(db: Database, repoId: string, value: unknown): void {
  let mine = waiting.get(db);
  if (!mine) waiting.set(db, (mine = new Map()));
  if (value === undefined) mine.delete(repoId);
  else mine.set(repoId, value as readonly WaitingToFinish[]);
}
