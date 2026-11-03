/**
 * What a nightly job printed, kept: the newest run's output of each job in
 * one file under `FORGE_APP_DATA/nightly`, so the `Flaky:` and `Red:`
 * issues it files can name the run (`runPath`) as the Forgejo jobs named
 * theirs, and one night here can be read beside one night there. Capped,
 * replaced by the next run, written in batches off the request path.
 *
 * `filedIn` reads back what the run filed from the lines
 * `scripts/flake-hunt.ts` prints when it does, and only from the hunt's own
 * steps (`readsFiled`): the hunt keeps the output of the tests it runs to
 * itself, so a test cannot print a line into the record. The record is
 * still advisory: it is what the default branch's script says it did, and
 * the issues themselves are the truth. Plain data.
 */

import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { Step } from "./jobs.ts";

/** Past this, a run's output is cut with a line that says so. */
export const OUTPUT_CAP_BYTES = 1_000_000;
/** Lines wait this long, or until this many bytes are waiting, before they are written. */
const FLUSH_MS = 1000;
const FLUSH_BYTES = 64 * 1024;

const fileOf = (dataDir: string, name: string): string => join(dataDir, "nightly", `${name}.log`);

/** The page that shows a job's newest output: what an issue it files links to. */
export const runPath = (name: string): string => `/resilience/nightly/${name}`;

export interface Output {
  /** Appends a line; it reaches the file within FLUSH_MS. */
  readonly write: (line: string) => void;
  /** Writes what waits; the output is whole once it settles. */
  readonly end: () => Promise<void>;
}

/** A fresh output file for `name`: the last night's is gone once this returns. */
export function startOutput(dataDir: string, name: string): Output {
  mkdirSync(join(dataDir, "nightly"), { recursive: true });
  const file = fileOf(dataDir, name);
  writeFileSync(file, "");
  let bytes = 0;
  let cut = false;
  let waiting = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One write at a time, in order; a full disk loses output, never the run.
  let written: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (waiting === "") return written;
    const text = waiting;
    waiting = "";
    written = written.then(() => appendFile(file, text)).catch(() => undefined);
    return written;
  };
  const add = (text: string): void => {
    waiting += text;
    if (waiting.length >= FLUSH_BYTES) void flush();
    else if (timer === undefined) {
      timer = setTimeout(() => void flush(), FLUSH_MS);
      timer.unref?.();
    }
  };
  return {
    write: (line) => {
      if (cut) return;
      const text = `${line}\n`;
      bytes += Buffer.byteLength(text);
      if (bytes > OUTPUT_CAP_BYTES) {
        cut = true;
        add(`… cut at ${OUTPUT_CAP_BYTES} bytes\n`);
        return;
      }
      add(text);
    },
    end: flush,
  };
}

/** The newest output of `name`, or undefined when it never ran here. */
export function readOutput(dataDir: string, name: string): string | undefined {
  try {
    return readFileSync(fileOf(dataDir, name), "utf8");
  } catch {
    return undefined;
  }
}

/** How far back `outputTail` reads: the tail never costs a whole capped file. */
const TAIL_BYTES = 16 * 1024;

/** The last `count` lines of `name`'s newest output, or undefined when it never ran here. */
export function outputTail(dataDir: string, name: string, count: number): string[] | undefined {
  let fd: number;
  try {
    fd = openSync(fileOf(dataDir, name), "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    // A read from the middle of the file starts mid-line: that piece is dropped.
    if (from > 0) lines.shift();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

/** Whether a step's output says what it filed: the hunt script's steps, never install. */
export const readsFiled = (step: Step): boolean => step.command.startsWith("bun scripts/flake-hunt.ts ");

// `  filed #12 for test/x.test.ts`, `  filed #12`, `  updated #3 for …`,
// `  closed #4 for …`, `quarantined …`: what flake-hunt.ts prints as it files.
const FILED = /^\s*(filed|updated|closed) #(\d+)\b/;
const QUARANTINED = /^quarantined (\S+)/;

/** What a run filed, in the order it did, as short phrases: `filed #12`, `quarantined test/x.test.ts`. */
export function filedIn(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const filed = FILED.exec(line);
    if (filed !== null) out.push(`${filed[1]} #${filed[2]}`);
    const moved = QUARANTINED.exec(line);
    if (moved !== null) out.push(`quarantined ${moved[1]}`);
  }
  return out;
}
