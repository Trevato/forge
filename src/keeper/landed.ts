/**
 * Seconds from landed to live (#8042): when the commit a release took was
 * merged, and when the new version first answered. Read from rows the forge
 * already keeps — the landing's `release` row and its pull's merge time, the
 * keeper's `live_at` — so there is nothing new to migrate. A commit that
 * landed without a pull of this forge counts from its checkout.
 */

import type { Database } from "bun:sqlite";
import { beatLine, lastBeat, SILENT_MS, type Beat } from "./beat.ts";
import { blocking, listHolds, standingHolds, type Hold } from "./hold.ts";
import { pendingNow, type NowRequest } from "./now.ts";
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
export type LandedRelease = KeeperRelease & {
  readonly commit: string;
  readonly landedToLiveSeconds: number | null;
  /** Where the release's time went (#11839): so the slow stage is named. */
  readonly stages: Stages;
};

/** Each stage's milliseconds, null where it was not measured or has not happened. */
export interface Stages {
  /** Tag cut to the new version answering. */
  readonly cutToLiveMs: number | null;
  readonly buildMs: number | null;
  readonly proofMs: number | null;
  readonly switchMs: number | null;
  /** The new version answering to its verdict. */
  readonly verifyMs: number | null;
}

const between = (from: string | null, to: string | null): number | null => {
  if (from === null || to === null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
};

export function stagesOf(r: Pick<KeeperRelease, "cutAt" | "liveAt" | "finishedAt" | "buildMs" | "proofMs" | "switchMs">): Stages {
  return {
    cutToLiveMs: between(r.cutAt, r.liveAt),
    buildMs: r.buildMs,
    proofMs: r.proofMs,
    switchMs: r.switchMs,
    verifyMs: between(r.liveAt, r.finishedAt),
  };
}

/** "cut→live 1 min 2 s · build 4 s · proof 3 s · switch 1 s · verify 10 min 0 s"; a stage not measured is left out. */
export function stagesLine(s: Stages): string {
  const w = (name: string, ms: number | null) => (ms === null ? [] : [`${name} ${secondsWords(Math.round(ms / 1000))}`]);
  return [...w("cut→live", s.cutToLiveMs), ...w("build", s.buildMs), ...w("proof", s.proofMs), ...w("switch", s.switchMs), ...w("verify", s.verifyMs)].join(" · ");
}

export function withLandedToLive(db: Database, releases: readonly KeeperRelease[]): LandedRelease[] {
  return releases.map((r) => ({ ...r, commit: r.sha.slice(0, 7), landedToLiveSeconds: landedToLive(db, r) ?? null, stages: stagesOf(r) }));
}

/** The tick's last heartbeat with its sentence and whether it has gone quiet (#11507); null before the first. */
export type Heartbeat = Beat & { readonly silent: boolean; readonly says: string };

export function heartbeatOf(db: Database, now: Date = new Date()): Heartbeat | null {
  const beat = lastBeat(db);
  if (beat === null) return null;
  return { ...beat, silent: now.getTime() - Date.parse(beat.at) > SILENT_MS, says: beatLine(beat, now) };
}

/** What the keeper did and what stops the next cut: one answer for MCP `release_keeper` and `GET /api/v1/keeper`. */
export function keeperAnswer(
  db: Database,
  now: Date = new Date(),
): { blocked: string | null; holding: string | null; releaseNow: NowRequest | null; releases: LandedRelease[]; holds: Hold[]; heartbeat: Heartbeat | null } {
  const heartbeat = heartbeatOf(db, now);
  return {
    blocked: blocking(standingHolds(db)) ?? null,
    // What the tick last said stopped it (the disk guard, the spacing, a snapshot): visible, not only in a log (#11839).
    holding: heartbeat !== null && heartbeat.outcome === "skipped" && !heartbeat.silent ? heartbeat.reason : null,
    releaseNow: pendingNow(db, now.getTime()) ?? null,
    releases: withLandedToLive(db, listKeeperReleases(db)),
    holds: listHolds(db),
    heartbeat,
  };
}
