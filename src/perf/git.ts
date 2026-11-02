/**
 * The rolling record of git processes (#8158): per subcommand, each spawn's
 * wall time, waiting for a permit included, so a queue of git processes on a
 * loaded machine is named rather than smeared across slow routes. The record
 * is the route record's (`record.ts`: 15-minute window, bounded samples and
 * keys); only the key differs. A key is `git <subcommand>` and the subcommand
 * is from a fixed list, so no argument, path or ref can ever be kept: anything
 * else is `git other`.
 */

import { createPerfRecord, type PerfRecord } from "./record.ts";

const SUBCOMMANDS = new Set([
  "add", "apply", "archive", "blame", "branch", "bundle", "cat-file", "checkout",
  "checkout-index", "cherry-pick", "clean", "clone", "commit", "commit-tree",
  "config", "count-objects", "diff", "diff-tree", "fetch", "for-each-ref", "fsck",
  "gc", "grep", "hash-object", "index-pack", "init", "log", "ls-files", "ls-remote",
  "ls-tree", "merge", "merge-base", "merge-file", "merge-tree", "mktree", "mv",
  "name-rev", "pack-objects", "pack-refs", "prune", "pull", "push", "read-tree",
  "rebase", "receive-pack", "reflog", "remote", "repack", "replay", "reset",
  "restore", "rev-list", "rev-parse", "revert", "rm", "show", "show-ref", "stash",
  "status", "switch", "symbolic-ref", "tag", "unpack-objects", "update-index",
  "update-ref", "update-server-info", "upload-pack", "verify-pack", "worktree",
  "write-tree",
]);

/** Global options that take their value as the next argument. */
const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

export const OTHER = "git other";

/** `git rev-parse` for `["-C", dir, "rev-parse", "--verify", ref]`; never an argument. */
export function gitKey(args: readonly string[]): string {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += VALUED.has(args[i]!) ? 2 : 1;
  const sub = args[i];
  return sub !== undefined && SUBCOMMANDS.has(sub) ? `git ${sub}` : OTHER;
}

const validKey = (key: string): boolean => key === OTHER || (key.startsWith("git ") && SUBCOMMANDS.has(key.slice(4)));

export function createGitRecord(): PerfRecord {
  return createPerfRecord(validKey);
}

/** Note one finished git process that started at `start` (performance.now()). */
export function noteGit(record: PerfRecord, args: readonly string[], start: number): void {
  record.add(gitKey(args), { at: Date.now(), ms: performance.now() - start, signedIn: false, phases: [] });
}
