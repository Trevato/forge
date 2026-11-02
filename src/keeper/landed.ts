/**
 * Seconds from landed to live (#8042): when the commit a release took was
 * merged, and when the new version first answered. Read from rows the forge
 * already keeps — the landing's `release` row and its pull's merge time, the
 * keeper's `live_at` — so there is nothing new to migrate. A commit that
 * landed without a pull of this forge counts from its checkout.
 */

import type { Database } from "bun:sqlite";
import { blocking, listHolds, standingHolds, type Hold } from "./hold.ts";
import { listKeeperReleases, type KeeperRelease } from "./record.ts";

/** When `sha` landed, epoch ms: its pull's merge, else the first time a landing checked it out. */
function landedAt(db: Database, sha: string): number | undefined {
  const row = db
    .query<{ at: string | null }, [string]>(
      `SELECT COALESCE(pull.merged_at, release.created_at) AS at FROM release
       LEFT JOIN issue ON issue.repo_id = release.repo_id AND issue.number = release.pull_number
       LEFT JOIN pull ON pull.issue_id = issue.id
       WHERE release.sha = ?1 ORDER BY release.id LIMIT 1`,
    )
    .get(sha);
  const ms = row?.at == null ? NaN : Date.parse(row.at);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Whole seconds from landing to the new version answering; undefined while it has not, or when the landing is unknown. */
export function landedToLive(db: Database, r: Pick<KeeperRelease, "sha" | "liveAt">): number | undefined {
  if (r.liveAt === null) return undefined;
  const landed = landedAt(db, r.sha);
  const live = Date.parse(r.liveAt);
  if (landed === undefined || !Number.isFinite(live)) return undefined;
  return Math.max(0, Math.round((live - landed) / 1000));
}

/** "1 min 12 s", "45 s". */
export function secondsWords(s: number): string {
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The newest release that went live and stayed (or is being verified), with its landed-to-live seconds. */
export function newestLive(db: Database): { version: string; sha: string; seconds: number } | undefined {
  for (const r of listKeeperReleases(db, 10)) {
    if (r.stage === "rolled_back") continue;
    const seconds = landedToLive(db, r);
    if (seconds !== undefined) return { version: r.version, sha: r.sha, seconds };
  }
  return undefined;
}

/** A keeper release with its short commit and landed-to-live seconds (null until it answered): what the card, the terminal and MCP show. */
export type LandedRelease = KeeperRelease & { readonly commit: string; readonly landedToLiveSeconds: number | null };

export function withLandedToLive(db: Database, releases: readonly KeeperRelease[]): LandedRelease[] {
  return releases.map((r) => ({ ...r, commit: r.sha.slice(0, 7), landedToLiveSeconds: landedToLive(db, r) ?? null }));
}

/** What the keeper did and what stops the next cut: one answer for MCP `release_keeper` and `GET /api/v1/keeper`. */
export function keeperAnswer(db: Database): { blocked: string | null; releases: LandedRelease[]; holds: Hold[] } {
  return {
    blocked: blocking(standingHolds(db)) ?? null,
    releases: withLandedToLive(db, listKeeperReleases(db)),
    holds: listHolds(db),
  };
}
