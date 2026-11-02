/**
 * A shard that ran out of room, told from a shard whose tests failed (#8679).
 *
 * The limit: a check's cell mounts its own `/tmp` as a 256 MiB tmpfs
 * (`TMP_MIB`, `apps/contain.ts`), whatever the machine's disk has free. Every
 * shard of the gate made its `TMPDIR` there, and the tests fill it with
 * sqlite databases, their journals and WAL files, cloned repositories and
 * sockets, so a few shards side by side reach 256 MiB while the disk shows
 * hundreds of GB free. SQLite answers `database or disk is full`
 * (SQLITE_FULL), the file's later `beforeAll`s fall over behind it as
 * `(unnamed)`, and the pull goes red for the machine. Two answers:
 * shards keep their temp on the cell's disk (`shardBase`, `shardHome`), and
 * when one still runs out the run's detail says so (`fullShard`), which the
 * crew reads as the environment's fault. `spaceLine` makes the next red name
 * its cause either way.
 */

import { mkdirSync, mkdtempSync, statfsSync } from "node:fs";
import { join } from "node:path";

/**
 * What a full tmpfs or disk prints, as an error: SQLite's SQLITE_FULL or the
 * kernel's ENOSPC, on a line that reports an error. A test that merely
 * mentions the words (as this pull's own does) is not one.
 */
const FULL_ERROR =
  /^\s*(?:error: |\w*Error: ).*(?:database or disk is full|SQLITE_FULL|ENOSPC|No space left on device)/;
const FAIL = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?(?: \[shard [0-9]+\])?$/;
const UNNAMED = /(^|> )\(unnamed\)(:|$)/;

/** The marker a run's detail carries when its temp space ran out. */
export const TEMP_FULL = "temp_full" as const;

/** The words a summary starts with when the environment, not the change, failed. */
export const OUT_OF_ROOM = "the check's temp space ran out";

/**
 * Where a shard's temp and data directories go: under `FORGE_CHECK_SCRATCH`,
 * the home the check service binds into the cell (a directory on the disk,
 * not the tmpfs), else `FORGE_APP_DATA` when one is set, else under the
 * system temp directory. The cell itself sets no `FORGE_APP_DATA`, so the
 * scratch variable is the one that matters there.
 */
export function shardBase(env: Readonly<Record<string, string | undefined>>, tmp: string): string {
  for (const key of ["FORGE_CHECK_SCRATCH", "FORGE_APP_DATA"]) {
    const dir = env[key];
    if (dir !== undefined && dir !== "") return dir;
  }
  return tmp;
}

/** A shard's own fresh directory under {@link shardBase}, made if the base is not there yet. */
export function shardHome(env: Readonly<Record<string, string | undefined>>, tmp: string): string {
  const base = shardBase(env, tmp);
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "shard-"));
}

/** What the check service adds to a cell's environment: its bound home, when it runs in a cell. */
export const scratchEnv = (home: string | undefined): Record<string, string> =>
  home === undefined ? {} : { FORGE_CHECK_SCRATCH: home };

/** One line of free space for each place a shard writes, for the log of a red shard. */
export function spaceLine(places: Readonly<Record<string, string>>): string {
  const mib = (n: number): string => `${Math.round(n / 1048576)} MiB`;
  const parts = Object.entries(places).map(([label, dir]) => {
    try {
      const fs = statfsSync(dir);
      const size = Number(fs.bsize);
      return `${label} ${dir}: ${mib(Number(fs.bavail) * size)} free of ${mib(Number(fs.blocks) * size)}`;
    } catch {
      return `${label} ${dir}: unreadable`;
    }
  });
  return `test-shards: space after a red shard: ${parts.join("; ")}`;
}

/**
 * Whether a log shows a shard that ran out of room: an error line (not any
 * line) carrying SQLITE_FULL or ENOSPC, and no more than one distinct named
 * test failing beside the `(unnamed)` hooks that fall over behind it. Two
 * named failures are the change's tests failing; the real list stays.
 */
export function fullShard(lines: readonly string[]): boolean {
  const at = lines.findIndex((line) => FULL_ERROR.test(line));
  if (at === -1) return false;
  const named = new Set<string>();
  for (const line of lines) {
    const fail = FAIL.exec(line);
    if (fail && !UNNAMED.test(fail[1]!)) named.add(fail[1]!.replace(/^test\/\S+ > /, ""));
  }
  return named.size <= 1;
}
