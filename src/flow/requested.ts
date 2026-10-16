/**
 * Pulls with changes requested, as /flow shows them (#2172): the ones
 * waiting on a builder (the verdict is on the head) apart from the ones
 * waiting on a reviewer (a push came since), each oldest first. Read from
 * `core/requested.ts`, the same rows the tick moves.
 *
 * A builder's wait starts at the verdict; a reviewer's at the head it has
 * not read yet, which is when that head's first run was queued (the
 * verdict's time when it has none).
 */

import type { Database } from "bun:sqlite";
import { requestedPulls, verdictIsStale } from "../core/requested.ts";
import { span } from "./pipeline.ts";

export interface WaitingPull {
  /** `owner/name`. */
  readonly repo: string;
  readonly number: number;
  readonly since: string;
}

export interface RequestedWaits {
  readonly builder: readonly WaitingPull[];
  readonly reviewer: readonly WaitingPull[];
}

/** `publicOnly` leaves out private repositories, for a reader who must not learn their names. */
export function requestedWaits(db: Database, publicOnly = false): RequestedWaits {
  const builder: WaitingPull[] = [];
  const reviewer: WaitingPull[] = [];
  const headSeen = db.query<{ at: string | null }, [string, string]>(
    `SELECT MIN(created_at) AS at FROM run WHERE issue_id = ?1 AND commit_oid = ?2`,
  );
  for (const p of requestedPulls(db)) {
    if (publicOnly && !p.isPublic) continue;
    if (!verdictIsStale(p)) {
      builder.push({ repo: p.repo, number: p.number, since: p.at });
      continue;
    }
    const at = headSeen.get(p.pullId, p.headOid)?.at ?? null;
    reviewer.push({ repo: p.repo, number: p.number, since: at !== null && at > p.at ? at : p.at });
  }
  const oldest = (a: WaitingPull, b: WaitingPull) =>
    a.since.localeCompare(b.since) || a.number - b.number;
  return { builder: builder.sort(oldest), reviewer: reviewer.sort(oldest) };
}

/** One sentence per kind of wait for /flow, or null when nothing waits on it. */
export function requestedSays(
  pulls: readonly WaitingPull[],
  on: "builder" | "reviewer",
  now = Date.now(),
): string | null {
  if (pulls.length === 0) return null;
  const list = pulls
    .slice(0, 5)
    .map((p) => `${p.repo}#${p.number} ${span(now - Date.parse(p.since))}`)
    .join(", ");
  const more = pulls.length > 5 ? `, and ${pulls.length - 5} more` : "";
  const what = pulls.length === 1 ? "pull" : "pulls";
  const verb = pulls.length === 1 ? "waits" : "wait";
  return `${pulls.length} ${what} with changes requested ${verb} on a ${on}, oldest first: ${list}${more}.`;
}
