/**
 * A run's log: one file, appended as the run goes, tailed live by whoever
 * is watching. The file is the truth — a surface that arrives late reads
 * it — and the in-process listeners are the optimisation that makes a log
 * line appear the moment it is written, on both surfaces, without a poll.
 *
 * Every line passes through `redactHeld` on the way in: credential shapes,
 * and the exact values a run was granted. A run's token
 * is in its environment, a curl in the agent's transcript may echo a
 * header, and a log page is read by people the token was never meant for.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { redactHeld } from "../kernel/log.ts";
import { noteActivity } from "./activity.ts";

export const runsRoot = (dataDir: string): string => join(dataDir, "runs");

export const runLogPath = (dataDir: string, runId: string): string =>
  join(runsRoot(dataDir), `${runId}.log`);

export type LogListener = (line: string) => void;

const listeners = new Map<string, Set<LogListener>>();

/** Who follows every run's log at once: the forge's `/events` streams. */
export type LogTap = (runId: string, lines: string[]) => void;

const taps = new Set<LogTap>();

/** Follow every run's new lines, redacted as written, until `signal` aborts. */
export function tapRunLogs(tap: LogTap, signal: AbortSignal): void {
  taps.add(tap);
  if (signal.aborted) taps.delete(tap);
  else signal.addEventListener("abort", () => taps.delete(tap), { once: true });
}

/** How many taps are open — a test seam for leaks. */
export const runLogTapCount = (): number => taps.size;

/** The most a single live frame carries. */
export const FRAME_MAX_LINES = 64;
export const FRAME_MAX_BYTES = 16 * 1024;

/** Lines cut to one frame's size; `truncated` says something was left out. */
export function frameOf(lines: readonly string[]): {
  lines: string[];
  truncated: boolean;
} {
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const room = FRAME_MAX_BYTES - bytes;
    const size = Buffer.byteLength(line);
    if (out.length >= FRAME_MAX_LINES || room <= 0)
      return { lines: out, truncated: true };
    if (size > room) {
      out.push(Buffer.from(line).subarray(0, room).toString("utf8"));
      return { lines: out, truncated: true };
    }
    out.push(line);
    bytes += size;
  }
  return { lines: out, truncated: false };
}

/** A line without its newline; a trailing newline is added on write. */
const MAX_LINE = 16 * 1024;

/** Append one line. Long lines are cut, never wrapped: a log is not a pager. */
export function appendRunLog(
  dataDir: string,
  runId: string,
  line: string,
): void {
  const clean = redactHeld(line.replace(/\r?\n/g, " ")).slice(0, MAX_LINE);
  mkdirSync(runsRoot(dataDir), { recursive: true });
  appendFileSync(runLogPath(dataDir, runId), `${clean}\n`);
  noteActivity(runId);
  for (const tap of taps) {
    try {
      tap(runId, [clean]);
    } catch {
      // A tap's failure is its own; the run keeps logging.
    }
  }
  const watching = listeners.get(runId);
  if (watching === undefined) return;
  for (const listener of watching) {
    try {
      listener(clean);
    } catch {
      // A watcher's failure is its own; the run keeps logging.
    }
  }
}

/** Every line so far, bounded to the last `maxBytes` of the file. */
export function readRunLog(
  dataDir: string,
  runId: string,
  maxBytes = 512 * 1024,
): { lines: string[]; truncated: boolean } {
  const path = runLogPath(dataDir, runId);
  if (!existsSync(path)) return { lines: [], truncated: false };
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    // A cut in the middle of a line leaves a partial first line; drop it.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return { lines, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * A window onto the end of a run's log, sized for a caller that wants
 * `maxLines` of them rather than a byte count to guess at. A worst-case
 * line runs to `MAX_LINE`, so `maxLines` of those plus one more (the
 * partial line `readRunLog` drops after the cut) is enough bytes to always
 * come back with at least `maxLines` whole lines, however long they run —
 * never the file's full history for a tail a few lines deep. The window
 * itself is returned unsliced: a caller after exactly `maxLines` takes the
 * last of them; one building a "N more above" notice (`logBox`) needs the
 * few extra to know there's more.
 */
export function readRunLogTail(
  dataDir: string,
  runId: string,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  const maxBytes = (maxLines + 1) * (MAX_LINE + 1);
  return readRunLog(dataDir, runId, maxBytes);
}

/**
 * Follow a run's log. Released by `signal` — a TUI screen's abort or an SSE
 * connection closing — so a dead watcher never holds a set entry.
 */
export function subscribeRunLog(
  runId: string,
  listener: LogListener,
  signal: AbortSignal,
): void {
  let watching = listeners.get(runId);
  if (watching === undefined) {
    watching = new Set();
    listeners.set(runId, watching);
  }
  watching.add(listener);
  const release = (): void => {
    const set = listeners.get(runId);
    if (set === undefined) return;
    set.delete(listener);
    if (set.size === 0) listeners.delete(runId);
  };
  if (signal.aborted) release();
  else signal.addEventListener("abort", release, { once: true });
}

/** How many runs currently have a listener set — a test seam for leaks. */
export const runLogListenerCount = (): number => listeners.size;
