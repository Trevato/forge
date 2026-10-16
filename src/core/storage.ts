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
import { getQuota } from "../settings/quotas.ts";
import type { User } from "./users.ts";

/** The limit is set in megabytes (decimal), the unit people say it in. */
export const BYTES_PER_MB = 1_000_000;

interface Entry {
  bytes: number;
  stale: boolean;
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
  entry.walking ??= measureAccount(app, ownerId)
    .then((bytes) => {
      entry.bytes = bytes;
      entry.stale = false;
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
    entry = { bytes: 0, stale: true };
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
  }
  return accountBytes(app, ownerId);
}

/** The last known figure, without waiting for anything. */
export function cachedBytes(app: App, ownerId: string): number | undefined {
  return cacheOf(app).get(ownerId)?.bytes;
}

/** A push, create, fork, mirror or delete changed the disk: measure again, off the request path. */
export function storageChanged(app: App, ownerId: string): void {
  const cache = cacheOf(app);
  const entry = cache.get(ownerId);
  if (entry === undefined) return;
  entry.stale = true;
  void walk(app, ownerId, entry).catch(() => {});
}

/** Bytes the way a person says them: `1.9 GB`, `340 MB`, `12 kB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${+(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${+(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** The storage limit in bytes, or none. */
export function storageLimitBytes(app: App): number | undefined {
  const mb = getQuota(app.db, "storage");
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
): Promise<string | undefined> {
  const limit = storageLimitBytes(app);
  if (limit === undefined || storageExempt(user)) return undefined;
  let used = await accountBytes(app, ownerId);
  // At the limit, look again: a repository deleted or data cleared since the
  // figure was taken must not keep an account locked out.
  if (used >= limit) used = await freshBytes(app, ownerId);
  return used >= limit ? sentence(used, limit) : undefined;
}

/** What a refused push says, over HTTP and SSH alike. */
export const storageRefusedText = (used: string): string =>
  `storage limit reached: ${used}; delete a repository or app data to push`;

/** The sentence for a refusal just given, from the figure it was given on. */
export function storageSentence(app: App, ownerId: string): string | undefined {
  const limit = storageLimitBytes(app);
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
): Promise<Record<string, string>> {
  const limit = storageLimitBytes(app);
  if (limit === undefined || storageExempt(user)) return {};
  const room = Math.max(1, limit - (await accountBytes(app, ownerId)));
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "receive.maxInputSize",
    GIT_CONFIG_VALUE_0: String(room),
  };
}
