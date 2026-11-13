/**
 * Where an estimate is settled (#11955), the one place: the forge hears of the event on the bus and
 * the actual instant is set, or what an abandoned issue promised is voided. Nothing else in the
 * core, the pulls or the keeper knows estimates exist. Only reads and writes `issue_estimate`,
 * `core/estimates.ts` does the rows.
 *
 *  - `pull.opened`: the issues the pull's description closes had a pull opened (its creation time).
 *  - `pull.merged`: the same issues merged (the pull's merge time).
 *  - `release.verified_live`: each open `live` estimate resolves at the first release, cut after
 *    its merge, that served.
 *  - `issue.closed` as dropped or split: what it left open is void. (Moving to Not now voids in
 *    `actions/next.ts`, the act that does it.)
 */
import type { Database } from "bun:sqlite";
import { settleEvent, settleLive, voidOpen, type ServedRelease } from "../core/estimates.ts";
import type { ForgeEvent } from "../core/events.ts";
import { getIssue } from "../core/issues.ts";
import { closesFromBody, mergedPullClosing } from "../core/pulls.ts";

/** The most releases one settling reads: the newest that served. */
const RELEASES_MAX = 200;

const numberOf = (e: ForgeEvent): number | undefined => {
  const n = e.payload["number"];
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
};

/** The pull's description and its two instants. */
function pullFacts(db: Database, repoId: string, number: number): { body: string; openedAt: string; mergedAt: string | null } | undefined {
  const row = db
    .query<{ body: string; created_at: string; merged_at: string | null }, [string, number]>(
      `SELECT i.body, i.created_at, p.merged_at FROM issue i JOIN pull p ON p.issue_id = i.id WHERE i.repo_id = ?1 AND i.number = ?2`,
    )
    .get(repoId, number);
  return row === null ? undefined : { body: row.body, openedAt: row.created_at, mergedAt: row.merged_at };
}

/** Releases that served and were not rolled back, oldest first. */
function servedReleases(db: Database): ServedRelease[] {
  return db
    .query<{ cut_at: string; live_at: string }, [number]>(
      `SELECT cut_at, live_at FROM keeper_release WHERE live_at IS NOT NULL AND stage != 'rolled_back' ORDER BY cut_at DESC LIMIT ?1`,
    )
    .all(RELEASES_MAX)
    .reverse()
    .map((r) => ({ cutAt: r.cut_at, liveAt: r.live_at }));
}

/** Settle what this event settles. Subscribed once, in `app.ts`. */
export function settleEstimates(db: Database, e: ForgeEvent): void {
  if (e.repoId === null) return;
  const number = numberOf(e);
  switch (e.kind) {
    case "pull.opened": {
      const pull = number === undefined ? undefined : pullFacts(db, e.repoId, number);
      if (pull !== undefined) settleEvent(db, e.repoId, closesFromBody(pull.body), "pull_opened", pull.openedAt);
      return;
    }
    case "pull.merged": {
      const pull = number === undefined ? undefined : pullFacts(db, e.repoId, number);
      if (pull !== undefined) settleEvent(db, e.repoId, closesFromBody(pull.body), "merged", pull.mergedAt ?? e.createdAt);
      return;
    }
    case "issue.closed": {
      const reason = e.payload["reason"];
      const issue = number === undefined ? undefined : getIssue(db, e.repoId, number);
      if (issue !== undefined && (reason === "dropped" || reason === "split")) voidOpen(db, issue.id, e.createdAt);
      return;
    }
    case "release.verified_live":
      settleLive(db, servedReleases(db), (repoId, n) => mergedPullClosing(db, repoId, n)?.mergedAt ?? undefined);
      return;
  }
}

