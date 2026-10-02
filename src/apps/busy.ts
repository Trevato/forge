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

/** Whether the process `pid` has a child process alive right now. */
export function hasChildren(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
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
