/**
 * What one account stores, and whether it may store more (the storage
 * quota, `settings/quotas.ts`): the bytes of the bare repositories it owns
 * plus the data of the apps built on them. Walking a large repository is
 * slow, so the figure is cached per account. A change (push, create, fork,
 * mirror, delete) marks it stale and starts a walk in the background; the
 * next check joins that walk rather than judge on a number the disk has
 * left, so only a first look or a check after a change waits. An account
 * found at its limit is measured once more before it is refused, at most
 * every `REWALK_MS`. The cache is memory, not state: git
 * and the data directory are the truth, and a restart measures again.
 */

import { join } from "node:path";
import type { App } from "../app.ts";
import { appsRoot } from "../apps/data.ts";
import { dirBytes } from "../apps/bytes.ts";
import { repoDir } from "../git/repos.ts";
import { limitValue } from "../settings/limits.ts";
import { getQuota, quotaOf } from "../settings/quotas.ts";
import { contributionForksOf, isContributionFork } from "./contribute.ts";
import type { Repo } from "./repos.ts";
import type { User } from "./users.ts";

/** The limit is set in megabytes (decimal), the unit people say it in. */
export const BYTES_PER_MB = 1_000_000;

interface Entry {
  bytes: number;
  stale: boolean;
  /** Bumped by every stale mark, so a walk can tell one arrived while it ran. */
  marks: number;
  /** When the last walk finished, in ms. */
  walkedAt?: number;
  walking?: Promise<number>;
}

const caches = new WeakMap<App, Map<string, Entry>>();

function cacheOf(app: App): Map<string, Entry> {
  let cache = caches.get(app);
  if (cache === undefined) caches.set(app, (cache = new Map()));
  return cache;
}

/** Walk the disk for one account: repositories it owns plus its apps' data. */
export async function measureAccount(app: App, ownerId: string): Promise<number> {
  const repos = app.db
    .query<{ name: string; owner: string }, [string]>(
      `SELECT repo.name AS name, user.username AS owner
         FROM repo JOIN user ON user.id = repo.owner_id WHERE repo.owner_id = ?1`,
    )
    .all(ownerId);
  const apps = app.db
    .query<{ id: string }, [string]>(
      "SELECT app.id AS id FROM app JOIN repo ON repo.id = app.repo_id WHERE repo.owner_id = ?1",
    )
    .all(ownerId);
  let total = 0;
  for (const r of repos) total += await dirBytes(repoDir(app.reposRoot, r.owner, r.name));
  for (const a of apps) total += await dirBytes(join(appsRoot(app.config.dataDir), a.id));
  return total;
}

function walk(app: App, ownerId: string, entry: Entry): Promise<number> {
  const marked = entry.marks;
  entry.walking ??= measureAccount(app, ownerId)
    .then((bytes) => {
      entry.bytes = bytes;
      // A mark that arrived mid-walk is not answered by this walk.
      entry.stale = entry.marks !== marked;
      entry.walkedAt = Date.now();
      return bytes;
    })
    .finally(() => {
      delete entry.walking;
    });
  return entry.walking;
}

/** The account's bytes: the cached figure, or the first walk. */
export async function accountBytes(app: App, ownerId: string): Promise<number> {
  const cache = cacheOf(app);
  let entry = cache.get(ownerId);
  if (entry === undefined) {
    entry = { bytes: 0, stale: true, marks: 0 };
    cache.set(ownerId, entry);
  }
  // A figure marked stale is never judged on: the walk a change began in the
  // background is joined, so a refusal never rests on a number the disk has left.
  return entry.stale ? walk(app, ownerId, entry) : entry.bytes;
}

/** The least time between two re-walks made only because an account is at its limit. */
export const REWALK_MS = 5_000;

/**
 * Measure again, whatever the cache holds — unless a walk finished within
 * `REWALK_MS`, so a locked-out client retrying cannot turn each retry into a
 * disk scan. A change (`storageChanged`) always walks, whatever the age.
 */
async function freshBytes(app: App, ownerId: string): Promise<number> {
  const entry = cacheOf(app).get(ownerId);
  if (entry !== undefined) {
    if (entry.walkedAt !== undefined && Date.now() - entry.walkedAt < REWALK_MS)
      return entry.bytes;
    entry.stale = true;
    entry.marks++;
  }
  return accountBytes(app, ownerId);
}

/** The last known figure, without waiting for anything. */
export function cachedBytes(app: App, ownerId: string): number | undefined {
  return cacheOf(app).get(ownerId)?.bytes;
}

/**
 * Fetched objects arrived without a push (a mirror's sync, a migrate import):
 * the figure is stale. Only marked: the walk is left to the next check, so a
 * sync never pays for walking the repository.
 */
export function storageStale(app: App, ownerId: string): void {
  const entry = cacheOf(app).get(ownerId);
  if (entry === undefined) return;
  entry.stale = true;
  entry.marks++;
}

/** A push, create, fork, mirror or delete changed the disk: measure again, off the request path. */
export function storageChanged(app: App, ownerId: string): void {
  const cache = cacheOf(app);
  const entry = cache.get(ownerId);
  if (entry === undefined) return;
  entry.stale = true;
  entry.marks++;
  void walk(app, ownerId, entry).catch(() => {});
}

/**
 * What a guest's contribution forks hold, walked on each ask: only a guest's
 * write comes here, and their forks are small because they borrow their
 * parents' history. An old account's other repositories are not counted.
 */
async function contributionRoom(
  app: App,
  ownerId: string,
  repo?: Repo,
): Promise<{ used: number; limit: number; room: number }> {
  const total = limitValue(app.db, "guest.storage_mb") * BYTES_PER_MB;
  let used = 0;
  for (const f of contributionForksOf(app.db, ownerId)) used += await dirBytes(repoDir(app.reposRoot, f.owner, f.name));
  let room = total - used;
  let limit = total;
  if (repo !== undefined) {
    const forkLimit = limitValue(app.db, "guest.fork_storage_mb") * BYTES_PER_MB;
    const here = await dirBytes(repoDir(app.reposRoot, repo.ownerName, repo.name));
    if (forkLimit - here < room) {
      room = forkLimit - here;
      used = here;
      limit = forkLimit;
    }
  }
  return { used, limit, room };
}

/**
 * The refusal a guest's next store gets, e.g. "50 MB of 50 MB", or nothing.
 * With `repo`, nothing unless it is a contribution fork and the writer no admin
 * or agent; without, the guest's whole allowance is asked before a new fork.
 */
export async function contributionRefusal(
  app: App,
  ownerId: string,
  repo?: Repo,
  writer?: User,
): Promise<string | undefined> {
  if (repo !== undefined && !isContributionFork(app.db, repo.id)) return undefined;
  if (writer !== undefined && storageExempt(writer)) return undefined;
  const { used, limit, room } = await contributionRoom(app, ownerId, repo);
  return room <= 0 ? sentence(used, limit) : undefined;
}

/** Bytes the way a person says them: `1.9 GB`, `340 MB`, `12 kB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${+(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${+(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** The storage limit in bytes, or none. */
export function storageLimitBytes(app: App, ownerId?: string): number | undefined {
  const mb = ownerId === undefined ? getQuota(app.db, "storage") : quotaOf(app.db, "storage", ownerId);
  return mb === null ? undefined : mb * BYTES_PER_MB;
}

/** Admins and agents are not held to the storage limit. */
export const storageExempt = (user: User): boolean => user.isAdmin || user.kind === "agent";

const sentence = (used: number, limit: number): string =>
  `${formatBytes(used)} of ${formatBytes(limit)}`;

/**
 * The refusal a store past the limit gets, e.g. "1.9 GB of 2 GB", or nothing
 * when `user` may store more under `ownerId`'s account. A soft quota: two
 * pushes at once can each pass.
 */
export async function storageRefusal(
  app: App,
  user: User,
  ownerId: string,
  /** The repository a push goes to: a guest's contribution fork answers to its own limits too. */
  repo?: Repo,
): Promise<string | undefined> {
  if (repo !== undefined) {
    const guest = await contributionRefusal(app, ownerId, repo, user);
    if (guest !== undefined) return guest;
  }
  const limit = storageLimitBytes(app, ownerId);
  if (limit === undefined || storageExempt(user)) return undefined;
  let used = await accountBytes(app, ownerId);
  // At the limit, look again: a repository deleted or data cleared since the
  // figure was taken must not keep an account locked out.
  if (used >= limit) used = await freshBytes(app, ownerId);
  return used >= limit ? sentence(used, limit) : undefined;
}

/** What a refused create, fork or mirror says, from the figure it was refused on. */
export function storageLimitMessage(app: App, ownerId: string): string {
  const sentence = storageSentence(app, ownerId);
  return sentence === undefined
    ? "this account is at the forge's storage limit"
    : `this account is at the forge's storage limit: ${sentence}`;
}

/** What a refused push says, over HTTP and SSH alike. */
export const storageRefusedText = (used: string): string =>
  `storage limit reached: ${used}; delete a repository or app data to push`;

/** The sentence for a refusal just given, from the figure it was given on. */
export function storageSentence(app: App, ownerId: string): string | undefined {
  const limit = storageLimitBytes(app, ownerId);
  const used = cachedBytes(app, ownerId);
  return limit === undefined || used === undefined || used < limit
    ? undefined
    : sentence(used, limit);
}

/**
 * git's own cap on the pack a push brings: the room left, so a push that
 * would pass the limit is stopped by git while it is still in quarantine,
 * and the repository is as it was. Env for the receive-pack process.
 */
export async function pushCap(
  app: App,
  user: User,
  ownerId: string,
  repo?: Repo,
): Promise<Record<string, string>> {
  if (storageExempt(user)) return {};
  const limit = storageLimitBytes(app, ownerId);
  const guest =
    repo !== undefined && isContributionFork(app.db, repo.id)
      ? (await contributionRoom(app, ownerId, repo)).room
      : undefined;
  if (limit === undefined && guest === undefined) return {};
  const account = limit === undefined ? Number.POSITIVE_INFINITY : limit - (await accountBytes(app, ownerId));
  const room = Math.max(1, Math.min(account, guest ?? Number.POSITIVE_INFINITY));
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "receive.maxInputSize",
    GIT_CONFIG_VALUE_0: String(room),
  };
}
