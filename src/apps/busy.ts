/**
 * Whether a running environment is in the middle of something, asked of
 * the process itself rather than of the clock: a child it started still
 * working (a build, a crew run inside a hosted forge), or a stream the
 * proxy holds open to it (a websocket, an event stream). The sleep sweep
 * leaves a busy environment awake — for a while, never forever
 * (`apps/runtime.ts`).
 *
 * Children are read from `/proc/<pid>/task/<tid>/children`. Where there is
 * no `/proc` the answer is "no children", so an environment sleeps on
 * time alone exactly as it did before this was asked.
 */

import { readdirSync, readFileSync } from "node:fs";

export type BusyReason = "children" | "stream";

/** Busy, in the words a page says it with. */
export const BUSY_WORDS: Record<BusyReason, string> = {
  children: "busy — its child processes are still working",
  stream: "busy — a stream to it is still open",
};

/**
 * A process that only exists to hold the app as its one child: nested
 * bubblewrap, the cell's `sh -c` wrapper, or `bun run` keeping the script.
 * Busy is about children *the app* started, not these.
 */
function appPid(pid: number): number {
  for (;;) {
    let cmd: string;
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      return pid;
    }
    // Only wrappers around the app — never `bun run` itself: that process
    // *is* the app when the script runs in-process, and its children are
    // the work (a sleep, a build) busy is meant to see.
    const supervisor =
      /\bbwrap\b/.test(cmd) ||
      /^\/bin\/sh\b/.test(cmd) ||
      /^sh\b/.test(cmd);
    if (!supervisor) return pid;
    const child = soleChild(pid);
    if (child === undefined) return pid;
    pid = child;
  }
}

/** The only child of `pid`, when it has exactly one. */
function soleChild(pid: number): number | undefined {
  const found: number[] = [];
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return undefined;
  }
  for (const tid of tasks) {
    try {
      const text = readFileSync(
        `/proc/${pid}/task/${tid}/children`,
        "utf8",
      ).trim();
      if (text === "") continue;
      for (const part of text.split(/\s+/)) {
        const n = Number(part);
        if (Number.isSafeInteger(n) && n > 0) found.push(n);
      }
    } catch {
      // The thread ended between the listing and the read.
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Whether the process `pid` has a child process alive right now. */
export function hasChildren(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  pid = appPid(pid);
  let tasks: string[];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return false;
  }
  for (const tid of tasks) {
    try {
      if (readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim())
        return true;
    } catch {
      // The thread ended between the listing and the read.
    }
  }
  return false;
}

/** Why an environment is busy, or undefined when it is not. */
export function busyReason(
  pid: number,
  openStreams: number,
): BusyReason | undefined {
  if (openStreams > 0) return "stream";
  if (hasChildren(pid)) return "children";
  return undefined;
}
