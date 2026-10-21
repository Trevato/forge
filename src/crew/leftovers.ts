/**
 * Claude Code's sandbox bridges that outlived their session (#3708). Each
 * session starts two `socat UNIX-LISTEN:<its temp dir>/…,fork TCP:…`
 * relays in its own process group; `runClaude` kills that group once the
 * session ends (`reapGroup`), and this sweep is the net under it — for a
 * session a forge before that fix, or a forge that died, left behind.
 *
 * A leftover is a `socat` whose parent is gone (re-parented to pid 1),
 * whose command line names a socket under the crew's directory. Nothing
 * else on the machine matches: a cell's relays live under its own init,
 * and a person's own socat never names the crew's directory.
 */

import { readFileSync } from "node:fs";
import type { ProcessRow } from "../kernel/census.ts";

/** The process groups to kill: one per leftover bridge, never this process's own. */
export function leftoverBridgeGroups(
  rows: readonly ProcessRow[],
  crewRoot: string,
  cmdline: (pid: number) => string = readCmdline,
  self = process.pid,
): number[] {
  const own = rows.find((r) => r.pid === self)?.pgid;
  const root = crewRoot.endsWith("/") ? crewRoot : `${crewRoot}/`;
  const groups = new Set<number>();
  for (const row of rows) {
    if (row.comm !== "socat" || row.ppid !== 1) continue;
    if (row.pgid <= 1 || row.pgid === own || row.pgid === self) continue;
    if (!cmdline(row.pid).includes(root)) continue;
    groups.add(row.pgid);
  }
  return [...groups];
}

/** SIGKILL each group; how many were there to kill. */
export function reapLeftoverBridges(
  rows: readonly ProcessRow[],
  crewRoot: string,
  kill: (pgid: number) => void = (pgid) => process.kill(-pgid, "SIGKILL"),
  cmdline: (pid: number) => string = readCmdline,
  self = process.pid,
): number {
  let reaped = 0;
  for (const pgid of leftoverBridgeGroups(rows, crewRoot, cmdline, self)) {
    try {
      kill(pgid);
      reaped++;
    } catch {
      // gone between the read and the kill
    }
  }
  return reaped;
}

function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}
