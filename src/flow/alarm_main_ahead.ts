/**
 * The "main is ahead of production" flow alarm (#11507): the forge's own main
 * head is proven green (its last finished check passed), differs from the
 * commit production runs, and has for longer than the setting
 * `release.ahead_minutes` (default 90). On 2026-11-11 production stood still
 * for 5 h 50 min with main green and nothing said so. Names production's
 * version and commit, how far main is ahead (commits and pulls), how long, and
 * the last time the release tick was heard from. Pure of the clock.
 */

import type { Database } from "bun:sqlite";
import { getRepo } from "../core/repos.ts";
import { agoWords, lastBeat } from "../keeper/beat.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";
import { running } from "../kernel/version.ts";
import { waitingRows } from "../release/landings.ts";

export const AHEAD_SETTING = "release.ahead_minutes";
export const AHEAD_DEFAULT_MIN = 90;

export interface MainAheadAlarm {
  readonly fired: boolean;
  /** When main first moved past production; while it is ahead. */
  readonly since?: string;
  readonly says: string;
  /** Facts for the issue and the ask; only when fired. */
  readonly facts?: readonly string[];
}

/** The minutes main may be ahead and green before the alarm; a whole number of 1 or more is the owner's, else 90. */
export function aheadMinutes(db: Database): number {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1").get(AHEAD_SETTING);
  const n = row === null ? NaN : Number(row.value);
  return Number.isInteger(n) && n >= 1 && n <= 10_080 ? n : AHEAD_DEFAULT_MIN;
}

/** The commit of the last finished check of the forge's default branch, when that check passed. */
function greenHead(db: Database): string | undefined {
  const [owner, name] = ownRepoPath().split("/");
  const repo = owner && name ? getRepo(db, owner, name) : undefined;
  if (repo === undefined) return undefined;
  const last = db
    .query<{ state: string; commit_oid: string }, [string, string]>(
      `SELECT state, commit_oid FROM run
        WHERE repo_id = ?1 AND kind = 'check' AND issue_id IS NULL AND env = ?2 AND state IN ('ok', 'failed')
        ORDER BY id DESC LIMIT 1`,
    )
    .get(repo.id, repo.defaultBranch);
  return last?.state === "ok" ? last.commit_oid : undefined;
}

export function mainAheadAlarm(db: Database, now: Date): MainAheadAlarm {
  const quiet = { fired: false, says: "Production runs main's head, or main's head is not proven green." } as const;
  // The cheap checks first: this runs on every /flow and home request, and the waiting pulls are read only once main's green head is not production's.
  const prod = running();
  if (prod.commit === null) return quiet;
  const head = greenHead(db);
  if (head === undefined || head.startsWith(prod.commit) || prod.commit.startsWith(head)) return quiet;
  const waiting = waitingRows(db);
  const first = waiting[0];
  if (first === undefined) return quiet;
  const wait = now.getTime() - Date.parse(first.at);
  const limit = aheadMinutes(db) * 60_000;
  if (!(wait > limit)) return { fired: false, since: first.at, says: `Main is ahead of production ${agoWords(wait).replace(" ago", "")}; not yet due.` };
  const commits = new Set(waiting.map((r) => r.oid).filter((o) => o !== "")).size || waiting.length;
  const pulls = waiting.length;
  const beat = lastBeat(db);
  const tick = beat === null ? "never" : agoWords(now.getTime() - Date.parse(beat.at));
  const how = `${commits} ${commits === 1 ? "commit" : "commits"} and ${pulls} ${pulls === 1 ? "pull" : "pulls"}`;
  const forHow = agoWords(wait).replace(" ago", "");
  const facts = [
    `production runs ${prod.version} at ${prod.commit.slice(0, 7)}`,
    `main is green at ${head.slice(0, 7)}, ${how} ahead`,
    `ahead since ${first.at}`,
    // Absolute times: the evidence is commented again only when it changes, not as the clock moves.
    // The tick's reason stays out: these facts are a Sentinel issue's, which may be public; /releases shows it to its readers.
    `the release tick was last heard from ${beat === null ? "never" : `${beat.at} (${beat.outcome})`}`,
  ];
  return {
    fired: true,
    since: first.at,
    says: `Main is green and ${how} ahead of production (${prod.version} at ${prod.commit.slice(0, 7)}) for ${forHow}; the release tick was last heard from ${tick}.`,
    facts,
  };
}

/** Main's state against production as one sentence for /releases and the terminal; undefined when main is not ahead and green. */
export function aheadLine(db: Database, now: Date): string | undefined {
  const a = mainAheadAlarm(db, now);
  return a.fired || a.since !== undefined ? a.says : undefined;
}
