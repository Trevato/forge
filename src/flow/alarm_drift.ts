/**
 * The "drifting pull" alarm (#6390): an open pull whose base is more than 25
 * landings, or 6 h, behind its repository's main. Rebase early, while it is
 * cheap. A landing is one first-parent commit on main past the merge base of
 * the pull's head and main (`base_oid` is the tip at opening and never moves,
 * so a rebased pull would stay named); the hours run from the first of them. Merged and closed pulls never count.
 */

import { existsSync } from "node:fs";

import type { App } from "../app.ts";
import { runGit } from "../git/env.ts";
import { isSafeName, isSafeOid, isSafeRef } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { span } from "./pipeline.ts";

export const DRIFT_LANDINGS = 25;
export const DRIFT_MS = 6 * 3_600_000;
const NAMED = 3;

export interface Drift {
  readonly number: number;
  readonly landings: number;
  /** When main first moved past the pull's base, epoch ms; null when it has not. */
  readonly since: number | null;
}

export interface DriftAlarm {
  readonly fired: boolean;
  readonly since?: string;
  readonly says: string;
}

interface Row {
  number: number;
  base_branch: string;
  head_oid: string;
  owner: string;
  name: string;
}

/** Landings on `branch` past where `headOid` forked from it and when the first happened, read from git; zero when unreadable. */
export async function readDrift(dir: string, branch: string, headOid: string): Promise<Omit<Drift, "number">> {
  const none = { landings: 0, since: null };
  if (!isSafeOid(headOid) || !isSafeRef(branch) || !existsSync(dir)) return none;
  const tip = `refs/heads/${branch}`;
  const fork = await runGit(["merge-base", headOid, tip], { cwd: dir });
  const base = fork.ok ? fork.value.trim() : "";
  if (!isSafeOid(base)) return none;
  const out = await runGit(["log", "--first-parent", "--format=%ct", `${base}..${tip}`], { cwd: dir });
  if (!out.ok) return none;
  const times = out.value.split("\n").filter(Boolean);
  const first = Number(times[times.length - 1]);
  return { landings: times.length, since: times.length > 0 && Number.isFinite(first) ? first * 1000 : null };
}

type Measure = Omit<Drift, "number">;
export type DriftReader = (dir: string, branch: string, headOid: string) => Promise<Measure>;

export const DRIFT_CACHE_MAX = 1000;
const cache = new Map<string, Measure>();

export function clearDriftCache(): void {
  cache.clear();
}

/** The tip of `branch`, one cheap git call; null when unreadable. */
export async function branchTip(dir: string, branch: string): Promise<string | null> {
  if (!isSafeRef(branch) || !existsSync(dir)) return null;
  const out = await runGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: dir });
  const oid = out.ok ? out.value.trim() : "";
  return isSafeOid(oid) ? oid : null;
}

/** `read` answered once per repository, head oid and main's tip; the oldest entries go past DRIFT_CACHE_MAX. */
export async function cachedDrift(
  read: DriftReader,
  dir: string,
  branch: string,
  headOid: string,
  tip: string | null,
  max = DRIFT_CACHE_MAX,
): Promise<Measure> {
  if (tip === null) return read(dir, branch, headOid);
  const key = `${dir}\0${branch}\0${headOid}\0${tip}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const fresh = await read(dir, branch, headOid);
  cache.set(key, fresh);
  while (cache.size > max) cache.delete(cache.keys().next().value as string);
  return fresh;
}

const behind = (d: Drift, now: number): number => (d.since === null ? 0 : now - d.since);
const drifting = (d: Drift, now: number): boolean => d.landings > DRIFT_LANDINGS || behind(d, now) > DRIFT_MS;

/** The alarm from the measured pulls: pure, so a test names `now` and the drift. */
export function driftAlarm(drifts: readonly Drift[], now: number): DriftAlarm {
  const hot = drifts.filter((d) => drifting(d, now));
  if (hot.length === 0) return { fired: false, says: "No open pull is drifting from main." };
  const worst = [...hot].sort((a, b) => b.landings - a.landings || behind(b, now) - behind(a, now) || a.number - b.number);
  const named = worst.slice(0, NAMED).map((d) =>
    d.landings > DRIFT_LANDINGS
      ? `#${d.number} is ${d.landings} landings behind main`
      : `#${d.number} is ${span(behind(d, now))} behind`,
  );
  const more = hot.length > NAMED ? `; and ${hot.length - NAMED} more` : "";
  const since = Math.min(...hot.map((d) => d.since ?? now));
  return { fired: true, since: new Date(since).toISOString(), says: `${named.join("; ")}${more}.` };
}

/** One open pull's drift and where it lives. */
export interface RepoDrift extends Drift {
  readonly repo: string;
}

/** Every open pull's drift from its repository's main; `publicOnly` leaves private repositories out. Git reads are cached per head and tip. */
export async function readDrifts(
  app: App,
  { read = readDrift, readTip = branchTip, publicOnly = false }: { read?: DriftReader; readTip?: typeof branchTip; publicOnly?: boolean } = {},
): Promise<RepoDrift[]> {
  const rows = app.db
    .query<Row, [number]>(
      `SELECT i.number, p.base_branch, p.head_oid, o.username AS owner, r.name
         FROM issue i JOIN pull p ON p.issue_id = i.id
         JOIN repo r ON r.id = i.repo_id JOIN user o ON o.id = r.owner_id
        WHERE i.kind = 'pull' AND i.state = 'open' AND p.merged_at IS NULL
          AND (?1 = 0 OR r.visibility = 'public')`,
    )
    .all(publicOnly ? 1 : 0)
    // A repository whose name cannot name a directory has no git to read: skip it, never fail the others.
    .filter((r) => isSafeName(r.owner) && isSafeName(r.name));
  const tips = new Map<string, Promise<string | null>>();
  const tipOf = (dir: string, branch: string) => {
    const k = `${dir}\0${branch}`;
    let t = tips.get(k);
    if (!t) tips.set(k, (t = readTip(dir, branch)));
    return t;
  };
  return Promise.all(
    rows.map(async (r) => {
      const dir = repoDir(app.reposRoot, r.owner, r.name);
      return { repo: `${r.owner}/${r.name}`, number: r.number, ...(await cachedDrift(read, dir, r.base_branch, r.head_oid, await tipOf(dir, r.base_branch))) };
    }),
  );
}

export interface DriftingPull {
  readonly repo: string;
  readonly number: number;
  readonly landings: number;
  /** Hours since main first moved past the pull's base, one decimal; 0 when it has not. */
  readonly hours: number;
}

/** The pulls past either limit, the furthest behind first: what /boards and the MCP `flow` tool list beside the one action that brings each up to date. */
export function driftingPulls(drifts: readonly RepoDrift[], now: number): DriftingPull[] {
  return drifts
    .filter((d) => drifting(d, now))
    .sort((a, b) => b.landings - a.landings || behind(b, now) - behind(a, now) || a.repo.localeCompare(b.repo) || a.number - b.number)
    .map((d) => ({ repo: d.repo, number: d.number, landings: d.landings, hours: Math.round(behind(d, now) / 360_000) / 10 }));
}

/** Reads every open pull's drift from its repository's main and answers the alarm. */
export async function alarmDrift(
  app: App,
  now: Date | number = Date.now(),
  opts: { read?: DriftReader; readTip?: typeof branchTip } = {},
): Promise<DriftAlarm> {
  const at = typeof now === "number" ? now : now.getTime();
  return driftAlarm(await readDrifts(app, opts), at);
}
