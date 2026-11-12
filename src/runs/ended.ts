/**
 * What a cancel ends, counted for the run's log (#10826). A run's work
 * leads a process group of its own (`detached`), or sits under bubblewrap
 * in a cell; either way the processes a cancel stops are the leader, every
 * live member of its group, and every live process below it. Counted the
 * moment before the signal, so the line says what the cancel reached.
 */
import { readdirSync, readFileSync } from "node:fs";

export interface ProcRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgrp: number;
  /** One letter from `/proc/<pid>/stat`: `Z` and `X` are already over. */
  readonly state: string;
}

/** Parse one `/proc/<pid>/stat`; undefined when it is not one. */
export function parseStat(pid: number, stat: string): ProcRow | undefined {
  // The command name is in parentheses and may hold spaces; fields after it are fixed.
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 2).split(" ");
  const state = fields[0] ?? "";
  const ppid = Number(fields[1]);
  const pgrp = Number(fields[2]);
  if (state === "" || !Number.isInteger(ppid) || !Number.isInteger(pgrp)) return undefined;
  return { pid, ppid, pgrp, state };
}

/** Every process this one can see; empty where there is no `/proc`. */
export function readProcs(): ProcRow[] {
  let names: string[];
  try {
    names = readdirSync("/proc");
  } catch {
    return [];
  }
  const rows: ProcRow[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const row = parseStat(Number(name), stat);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/** The live pids a stop of `leader` reaches: the leader, its group, its descendants. */
export function treeOf(rows: readonly ProcRow[], leader: number): number[] {
  const live = rows.filter((r) => r.state !== "Z" && r.state !== "X");
  const children = new Map<number, number[]>();
  for (const r of live) {
    const list = children.get(r.ppid);
    if (list === undefined) children.set(r.ppid, [r.pid]);
    else list.push(r.pid);
  }
  const reached = new Set<number>();
  if (live.some((r) => r.pid === leader)) reached.add(leader);
  for (const r of live) if (r.pgrp === leader) reached.add(r.pid);
  // A group member may have children outside the group (a `setsid`): walk
  // down from every one reached, each pid once.
  const walked = new Set<number>();
  const stack = [...reached];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (walked.has(pid)) continue;
    walked.add(pid);
    for (const child of children.get(pid) ?? []) {
      reached.add(child);
      stack.push(child);
    }
  }
  return [...reached].sort((a, b) => a - b);
}

/** The live processes a cancel of `leader` is about to end, read now. */
export const liveTree = (leader: number): number[] => treeOf(readProcs(), leader);

/** The one log line a cancel writes. */
export function endedLine(count: number): string {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  return `cancel ended ${n} ${n === 1 ? "process" : "processes"}`;
}
