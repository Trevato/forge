/**
 * What a check keeps for the next one (#1797). A check's checkout is a
 * fresh export every time, so `tsc` ran cold in every check and the gate's
 * per-file times died with the checkout. `.forge-cache/` in the checkout is
 * the one place that outlives it: after a green check of the default
 * branch its regular files are copied under the data directory, keyed by
 * that commit, and a later check of the repository starts with them — a
 * pull's check with the copy its base's own check left, else the newest.
 *
 * Only the default branch writes: a pull's code never fills a cache another
 * check reads (a forged `.tsbuildinfo` could tell `tsc` a file has no
 * errors). Only regular files, flat, by a safe name and bounded in count
 * and bytes, are copied either way: a symlink planted in the checkout is
 * never followed out of it.
 */

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isSafeOid } from "../git/guard.ts";

/** The directory, relative to the checkout, the check command writes to. */
export const CHECK_CACHE = ".forge-cache";

/** How many default-branch commits' caches a repository keeps. */
export const CACHE_KEEP = 4;
/** At most this many files, and this many bytes, are kept per commit. */
export const CACHE_FILES = 32;
export const CACHE_BYTES = 64 * 1024 * 1024;

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

const repoCache = (dataDir: string, repoId: string): string =>
  join(dataDir, "check-cache", repoId.replace(/[^A-Za-z0-9_-]/g, "_"));

/** The regular files of `dir` worth copying, or none if it breaks a bound. */
function keepable(dir: string): string[] {
  // The directory itself is not followed either: a link to elsewhere is no cache.
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  let bytes = 0;
  for (const name of names.sort()) {
    if (!NAME.test(name)) continue;
    const stat = lstatSync(join(dir, name), { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    bytes += stat.size;
    files.push(name);
  }
  return files.length > CACHE_FILES || bytes > CACHE_BYTES ? [] : files;
}

/**
 * Seed `checkout/.forge-cache` from the first of `keys` (commit ids) that
 * has a cache, else the newest one. Answers the key used, if any.
 */
export function restoreCache(
  dataDir: string,
  repoId: string,
  keys: readonly string[],
  checkout: string,
): string | undefined {
  const root = repoCache(dataDir, repoId);
  const into = join(checkout, CHECK_CACHE);
  // Whatever the tree carried under the name is not a cache.
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  const key =
    keys.find((key) => isSafeOid(key) && statSync(join(root, key), { throwIfNoEntry: false })?.isDirectory()) ??
    newest(root);
  if (key === undefined) return undefined;
  for (const name of keepable(join(root, key)))
    copyFileSync(join(root, key, name), join(into, name));
  return key;
}

/**
 * Keep `checkout/.forge-cache` as the cache of `commit`, replacing any copy
 * under that key whole, and drop all but the newest {@link CACHE_KEEP}.
 */
export function keepCache(
  dataDir: string,
  repoId: string,
  commit: string,
  checkout: string,
): boolean {
  if (!isSafeOid(commit)) return false;
  const from = join(checkout, CHECK_CACHE);
  const files = keepable(from);
  if (files.length === 0) return false;
  const root = repoCache(dataDir, repoId);
  const staging = join(root, `.${commit}.${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const name of files) copyFileSync(join(from, name), join(staging, name));
  rmSync(join(root, commit), { recursive: true, force: true });
  renameSync(staging, join(root, commit));
  for (const old of byAge(root).slice(CACHE_KEEP))
    rmSync(join(root, old), { recursive: true, force: true });
  return true;
}

/** The commits with a cache, newest first. */
function byAge(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root).filter(isSafeOid);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, at: statSync(join(root, name), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => b.at - a.at || (a.name < b.name ? -1 : 1))
    .map((entry) => entry.name);
}

const newest = (root: string): string | undefined => byAge(root)[0];
