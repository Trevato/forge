/**
 * What the tests row of a running check's run page adds to its name: how
 * many files the shard runner has started out of the run's count, the file
 * (or files) in the shard running now, and every failure so far with the
 * first lines `bun test` printed for it. Read only from the shard runner's
 * own lines and `bun test`'s `(fail)` markers; a figure the log does not
 * give is left out, never guessed.
 */

import { parseShardProgress, type CheckProgress } from "./progress.ts";
import { clip } from "../text/clip.ts";

export type PinnedFailure = {
  readonly name: string;
  /** The first lines of what was printed above the `(fail)` marker. */
  readonly lines: readonly string[];
};

export type TestsRow = CheckProgress & {
  /** Files in shards that have begun, finished or not. */
  started?: number;
  /** The files of the live shard that has not finished, if one is open. */
  running?: readonly string[];
  failures: readonly PinnedFailure[];
};

const SHARD_LIVE_OPEN = /^── shard \d+\/\d+: (.+)$/;
const SHARD_BATCHED = /^── shard \d+\/\d+ \(exit \d+, [0-9.]+s\): (.+)$/;
const SHARD_DONE = /^── shard \d+\/\d+ done \(exit \d+, [0-9.]+s\)$/;
const FAIL_LINE = /^\(fail\) (.+?)(?: \[[0-9.]+m?s\])?(?: \[shard [0-9]+\])?$/;
/** Lines that end one test's output and so bound the next one's. */
const BOUNDARY = /^(?:\(pass\) |\(skip\) |\(todo\) |── |test-shards: |\$ )|\.test\.[cm]?[jt]sx?:$/;

export const MAX_PINNED = 5;
export const PIN_LINES = 3;
const LINE_MAX = 200;

const names = (text: string): string[] => text.split(" ").filter((n) => n !== "");
const bound = (text: string): string => clip(text, LINE_MAX);

export function parseTestsRow(lines: readonly string[]): TestsRow {
  const base = parseShardProgress(lines);
  let started: number | undefined;
  let running: string[] | undefined;
  const failures: PinnedFailure[] = [];
  // Lines since the last boundary: the failing test's own output.
  let block: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    const live = SHARD_LIVE_OPEN.exec(line);
    const batched = SHARD_BATCHED.exec(line);
    if (live) {
      running = names(live[1]!);
      started = (started ?? 0) + running.length;
    } else if (batched) {
      started = (started ?? 0) + names(batched[1]!).length;
    } else if (SHARD_DONE.test(line)) {
      running = undefined;
    }
    const fail = FAIL_LINE.exec(line);
    if (fail) {
      const name = bound(fail[1]!);
      if (failures.length < MAX_PINNED && !failures.some((f) => f.name === name))
        failures.push({ name, lines: block.slice(0, PIN_LINES).map(bound) });
      block = [];
      continue;
    }
    if (BOUNDARY.test(line)) {
      block = [];
      continue;
    }
    if (line.trim() !== "") block.push(line.trim());
  }
  const row: TestsRow = { ...base, failures };
  if (started !== undefined) row.started = started;
  if (running !== undefined) row.running = running;
  return row;
}

/** `3 of 9 files started`, `812 passed, 1 failed`: the parts that are known. */
export function testsRowWords(row: TestsRow): string {
  const parts: string[] = [];
  if (row.started !== undefined && row.of !== undefined && row.started <= row.of)
    parts.push(`${row.started} of ${row.of} files started`);
  if (row.passed !== undefined && row.failed !== undefined)
    parts.push(`${row.passed} passed, ${row.failed} failed`);
  return parts.join(" · ");
}

/**
 * The terminal's words for the same row: `tests 2 of 9 files started · 812
 * passed, 1 failed · failing: a, b`, empty when the log gave nothing.
 */
export function testsRowLine(row: TestsRow): string {
  const words = testsRowWords(row);
  const pins = row.failures.map((f) => f.name).join(", ");
  const parts = [words, pins === "" ? "" : `failing: ${pins}`].filter((p) => p !== "");
  return parts.length === 0 ? "" : `tests ${parts.join(" · ")}`;
}
