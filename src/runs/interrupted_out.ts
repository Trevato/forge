/**
 * Runs the forge's host interruptions gave up on (#11583, #11693), as plain data: the last
 * 24 hours, newest first, one per issue, none once a newer run of that issue
 * exists (Try again made one). Home's line and the terminal screen share it.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "../core/repos.ts";
import { INTERRUPTED_OUT, STOPPED_TWICE_LEGACY } from "../crew/dispatch.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_STOPPED = 5;

export interface InterruptedOut {
  runId: string;
  repo: Repo;
  number: number;
  title: string;
  /** The reason, in the words the run carries. */
  reason: string;
}

interface Row {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  summary: string;
}

/** One bounded query over the repositories given (the ones this person may write). */
export function interruptedOutRuns(db: Database, writable: readonly Repo[], now = Date.now()): InterruptedOut[] {
  const byId = new Map<string, Repo>(writable.map((r) => [r.id, r]));
  if (byId.size === 0) return [];
  const since = new Date(now - WINDOW_MS).toISOString();
  const marks = [...byId.keys()].map(() => "?").join(",");
  return db
    .query<Row, (string | number)[]>(
      `SELECT r.id, r.repo_id, i.number, i.title, r.summary
         FROM run r JOIN issue i ON i.id = r.issue_id
        WHERE r.kind = 'agent' AND r.state = 'failed' AND r.summary IN (?, ?)
          AND r.finished_at >= ? AND r.repo_id IN (${marks})
          AND NOT EXISTS (SELECT 1 FROM run n WHERE n.issue_id = r.issue_id AND n.kind = 'agent' AND n.id > r.id)
        ORDER BY r.finished_at DESC LIMIT ${MAX_STOPPED}`,
    )
    .all(INTERRUPTED_OUT, STOPPED_TWICE_LEGACY, since, ...byId.keys())
    .map((row) => ({ runId: row.id, repo: byId.get(row.repo_id)!, number: row.number, title: row.title, reason: row.summary }));
}
