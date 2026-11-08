/**
 * How far a mirror's origin has moved on: the commits on the origin's default
 * branch that the mirror's has not taken yet.
 *
 * A reading is one fetch of the origin's tip — objects only, no ref moves, so
 * nothing the mirror serves changes — and a count. It is kept as a cursor
 * (a cache: losing it costs one reading) and shown on the repository's head
 * with the one action that takes the commits. The action is the mirror's own
 * sync, so a mirror takes exactly what a sweep would; the difference is that
 * a mirror whose default branch holds commits the origin lacks is not
 * overwritten, it is reported as a conflict.
 *
 * Never throws: it runs from the worker's tick and from a click.
 */

import type { App } from "../app.ts";
import {
  clearCursor,
  getCursor,
  listAllOrigins,
  listMirrors,
  originForRepo,
  setCursor,
} from "../core/origins.ts";
import { canRead, getRepoById, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isSafeOid } from "../git/guard.ts";
import { aheadCount, resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import { providerForOrigin } from "./credential.ts";
import { fetchRefFrom } from "./git-mirror.ts";

/** How stale a reading may be before the tick takes another. */
export const AHEAD_EVERY_MS = 2 * 60_000;
/** Readings one tick takes, so a slow origin cannot hold the others. */
const MAX_READINGS = 4;

export interface Ahead {
  /** New commits on the origin's default branch. */
  readonly count: number;
  /** The origin's tip when read. */
  readonly tip: string;
  /** The mirror holds commits the origin does not: taking would overwrite them. */
  readonly diverged: boolean;
  readonly at: string;
}

const aheadKey = (repoId: string): string => `repo:${repoId}:ahead`;

/** The last reading of a mirror, or undefined when there is none or it is level. */
export function aheadOf(app: App, repo: Repo): Ahead | undefined {
  if (repo.origin === null) return undefined;
  return parseAhead(getCursor(app.db, repo.origin.originId, aheadKey(repo.id)));
}

export function parseAhead(value: string | undefined): Ahead | undefined {
  const [count, tip, diverged, at] = (value ?? "").split(" ");
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || !isSafeOid(tip ?? "") || at === undefined) return undefined;
  return { count: n, tip: tip!, diverged: diverged === "1", at };
}

/** A sync took the commits: the reading is of an origin that has since moved. */
export function forgetAhead(app: App, originId: string, repoId: string): void {
  clearCursor(app.db, originId, aheadKey(repoId));
}

/** Read one mirror against its origin now. Returns the reading, or undefined when it could not be taken. */
export async function readAhead(app: App, repo: Repo): Promise<Ahead | undefined> {
  try {
    return await read(app, repo);
  } catch (error) {
    app.log.warn("ahead reading failed", { repo: repo.id, error: String(error) });
    return undefined;
  }
}

async function read(app: App, repo: Repo): Promise<Ahead | undefined> {
  const link = originForRepo(app.db, repo.id);
  if (link === undefined || link.origin.needsReauth || link.cloneUrl === "") return undefined;
  const provider = providerForOrigin(app, link.origin);
  if (!provider.ok) return undefined;
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const main = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (main === undefined) return undefined;
  const authEnv = await provider.value.gitAuthEnv(link.cloneUrl);
  const fetched = await fetchRefFrom(dir, link.cloneUrl, `refs/heads/${repo.defaultBranch}`, authEnv);
  if (!fetched.ok) return undefined;
  const tip = fetched.value;
  setCursor(app.db, link.origin.id, `repo:${repo.id}:ahead-read`, new Date().toISOString());
  const count = tip === main ? 0 : await aheadCount(dir, main, tip);
  const key = aheadKey(repo.id);
  if (count === 0) {
    clearCursor(app.db, link.origin.id, key);
    return { count: 0, tip, diverged: false, at: new Date().toISOString() };
  }
  const diverged = (await aheadCount(dir, tip, main)) > 0;
  const reading = { count, tip, diverged, at: new Date().toISOString() };
  setCursor(app.db, link.origin.id, key, `${count} ${tip} ${diverged ? 1 : 0} ${reading.at}`);
  return reading;
}

/**
 * The tick's pass: the mirrors read longest ago, a few at a time. A mirror
 * with no reading is read first.
 */
export async function readAheadDue(app: App, now = Date.now()): Promise<number> {
  const seen: { repoId: string; at: number }[] = [];
  for (const origin of listAllOrigins(app.db)) {
    if (origin.needsReauth) continue;
    for (const mirror of listMirrors(app.db, origin.id)) {
      const last = getCursor(app.db, origin.id, `repo:${mirror.repoId}:ahead-read`);
      seen.push({ repoId: mirror.repoId, at: last === undefined ? 0 : Date.parse(last) });
    }
  }
  let read = 0;
  // Each reading is one fetch bounded by FETCH_TIMEOUT_MS (git-mirror.ts), and
  // at most MAX_READINGS run, one after another. They run under their own
  // guard (runAheadReads), never the sweep's: a slow origin here delays only
  // the next reading, never a sync.
  for (const repoId of pickDue(seen, now)) {
    const repo = getRepoById(app.db, repoId);
    const link = repo === undefined ? undefined : originForRepo(app.db, repoId);
    if (repo === undefined || link === undefined) continue;
    setCursor(app.db, link.origin.id, `repo:${repoId}:ahead-read`, new Date(now).toISOString());
    await readAhead(app, repo);
    read++;
  }
  return read;
}

/**
 * The timer's entry point, beside `runSync` and apart from it: single-flight
 * per forge under its own guard, so a reading stuck on a slow origin never
 * holds the sweep, and the sweep never holds a reading. Never throws.
 */
export function runAheadReads(app: App): Promise<void> {
  const running = reading.get(app);
  if (running !== undefined) return running;
  const run = readAheadDue(app)
    .then(() => undefined)
    .catch((error: unknown) => {
      app.log.error("ahead readings failed", { error: String(error) });
    })
    .finally(() => {
      reading.delete(app);
    });
  reading.set(app, run);
  return run;
}

const reading = new WeakMap<App, Promise<void>>();

/** For tests: whether a pass of readings is running. */
export const aheadBusy = (app: App): boolean => reading.has(app);

/** Which mirrors one tick reads: those not read for AHEAD_EVERY_MS, longest-ago first, at most MAX_READINGS. */
export function pickDue(seen: readonly { repoId: string; at: number }[], now: number): string[] {
  return seen
    .filter((m) => now - m.at >= AHEAD_EVERY_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_READINGS)
    .map((m) => m.repoId);
}

/** What the head says of a reading: the count, and a conflict when taking would overwrite. */
export function aheadWords(ahead: Ahead): string {
  const n = `${ahead.count} new commit${ahead.count === 1 ? "" : "s"} upstream`;
  return ahead.diverged ? `${n} · conflicts with commits here` : n;
}

/**
 * Every mirror the viewer may read whose last reading found the origin ahead:
 * one query for the readings that exist, so the cost is the mirrors behind,
 * not the repositories visible.
 */
export function mirrorsBehind(app: App, viewer: User | undefined): { repo: Repo; ahead: Ahead }[] {
  const rows = app.db
    .query<{ id: string; value: string }, []>(
      `SELECT repo.id, origin_cursor.value FROM origin_cursor
       JOIN repo ON repo.origin_id = origin_cursor.origin_id
                AND origin_cursor.key = 'repo:' || repo.id || ':ahead'
       ORDER BY repo.id`,
    )
    .all();
  const out: { repo: Repo; ahead: Ahead }[] = [];
  for (const row of rows) {
    const repo = getRepoById(app.db, row.id);
    const ahead = parseAhead(row.value);
    if (repo !== undefined && ahead !== undefined && canRead(app.db, repo, viewer)) out.push({ repo, ahead });
  }
  return out;
}

/** The reading of a mirror to someone who may read it; nothing otherwise. */
export function aheadFor(app: App, repo: Repo, viewer: User | undefined): Ahead | undefined {
  return canRead(app.db, repo, viewer) ? aheadOf(app, repo) : undefined;
}

export const CONFLICT_WORDS = (branch: string, count: number): string =>
  `${branch} here holds commits the origin lacks, so taking its ${count} would overwrite them. Nothing moved; Sync now replaces ${branch} with what the origin has.`;
/** Why the sweep left a mirror's git alone: shown where its last fetch is. */
export const HELD_WORDS = (branch: string): string =>
  `${branch} here holds commits the origin lacks, so the sweep left the git alone. Sync now replaces ${branch} with what the origin has.`;
export const UNREAD_WORDS = "The origin could not be read just now, so nothing was taken. Try again shortly.";
