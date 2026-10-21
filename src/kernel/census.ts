/**
 * The machine's process table, read from `/proc`: every process this
 * forge can see, by command name (#3708). A pod that quietly gathers 255
 * `socat`s is a leak no single owner notices; a count by name on a regular
 * line is how one is noticed before it costs a crash.
 *
 * `root` is a parameter so a test can hand over a table it made.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** The kernel's command name (`/proc/<pid>/stat`'s second field), at most 15 bytes. */
  readonly comm: string;
}

/** Every process in `root` (default `/proc`); one that goes mid-read is skipped. */
export function processRows(root = "/proc"): ProcessRow[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const rows: ProcessRow[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(join(root, name, "stat"), "utf8");
    } catch {
      continue;
    }
    const row = parseStat(stat);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/**
 * One `/proc/<pid>/stat` line: `pid (comm) state ppid pgrp …`. The name
 * sits in parentheses and may hold spaces and parentheses itself, so the
 * fields after it are found from the last `)`.
 */
export function parseStat(stat: string): ProcessRow | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const pid = Number(stat.slice(0, open).trim());
  const fields = stat.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  if (![pid, ppid, pgid].every(Number.isSafeInteger)) return undefined;
  return { pid, ppid, pgid, comm: stat.slice(open + 1, close) };
}

/** How many processes carry each command name, but this process itself. */
export function census(rows: readonly ProcessRow[], self = process.pid): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.pid === self) continue;
    out.set(row.comm, (out.get(row.comm) ?? 0) + 1);
  }
  return out;
}

/** The `top` most common names as `socat=255 bwrap=148 …`, most first, ties by name. */
export function censusWords(counts: ReadonlyMap<string, number>, top = 8): string {
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, top)
    .map(([comm, n]) => `${comm.replace(/[\s=]/g, "_")}=${n}`)
    .join(" ");
}
