/**
 * Stale git locks in a kept clone. Git never removes another process's lock,
 * and a run the forge interrupted leaves its `config.lock` or `index.lock`
 * behind in a clone the forge keeps; every later visit would fail on it.
 * The runner calls this before it touches a clone it is about to own, so no
 * git process of this forge holds it; the age guard keeps a lock a person's
 * own git just took.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const STALE_LOCK_MS = 60_000;

/** Whether a failed git command died on a lock file. */
export const lockedOut = (stderr: string): boolean =>
  /\.lock'?: File exists|Unable to create '[^']*\.lock'|could not lock config file/i.test(
    stderr,
  );

function locksUnder(dir: string, deep: boolean): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".lock")) found.push(path);
    else if (deep && entry.isDirectory())
      found.push(...locksUnder(path, true));
  }
  return found;
}

/** Remove `.git/*.lock` and `.git/refs/**\/*.lock` older than a minute. */
export function clearStaleLocks(
  clone: string,
  write: (line: string) => void,
  now = Date.now(),
): string[] {
  const git = join(clone, ".git");
  if (!existsSync(git)) return [];
  const removed: string[] = [];
  for (const path of [
    ...locksUnder(git, false),
    ...locksUnder(join(git, "refs"), true),
  ]) {
    try {
      if (now - statSync(path).mtimeMs < STALE_LOCK_MS) continue;
      rmSync(path, { force: true });
      removed.push(path);
      write(`removed stale git lock ${path.slice(clone.length + 1)}`);
    } catch {
      // Gone already, or not ours to remove: git will say so if it matters.
    }
  }
  return removed;
}
