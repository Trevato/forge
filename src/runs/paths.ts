/**
 * The forge's own directories stripped from a line of output — the data
 * directory, the app's id, the environment and the per-commit checkout are
 * the forge's private layout, not the app's; a stack trace naming
 * `dir/src/server.ts:1:11` reads as `src/server.ts:1:11` instead, the path
 * the app's own source control knows. Applied where output is captured, not
 * filtered — a line with no match passes through whole, so a message never
 * loses its stack for the sake of hiding a directory.
 *
 * A directory is stripped only where it stands as a whole path: not where
 * its text sits in the middle of a longer one (`/private` + `/var/x`, the
 * same directory seen through a symlink), and not where it is the start of
 * a sibling's name (`/data/1/2` in `/data/1/23`, or `/data/1/2.bak`).
 * Taking a piece out of a path leaves a path that never existed. A full
 * stop that ends a sentence is not part of the path: `wrote to <dir>.`
 * reads `wrote to .`, the sentence's own stop standing for "here".
 *
 * An empty `dir` is dropped: there is nothing to strip.
 */

import { realpathSync } from "node:fs";

/** What a path segment is made of: a directory ends where these do. */
const SEGMENT = /[\w.~-]/;

export function stripForgeDirs(dirs: readonly string[], line: string): string {
  return dirs.filter((dir) => dir !== "").reduce(strip, line);
}

function strip(line: string, dir: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const at = line.indexOf(dir, from);
    if (at === -1) return out + line.slice(from);
    const end = at + dir.length;
    const next = line[end];
    const after = line[end + 1];
    const stop = next === "." && (after === undefined || /\s/.test(after));
    const whole =
      (at === 0 || !SEGMENT.test(line[at - 1]!)) &&
      (next === undefined || next === "/" || stop || !SEGMENT.test(next));
    if (!whole) {
      out += line.slice(from, end);
      from = end;
    } else if (next === "/" || stop) {
      out += line.slice(from, at);
      from = next === "/" ? end + 1 : end;
    } else {
      out += `${line.slice(from, at)}.`;
      from = end;
    }
  }
}

/**
 * Every way the given directories are spelled: as the forge named them, and
 * as the system resolves them when that differs — a data directory behind a
 * symlink, or macOS's `/var` and `/tmp`, which a child process reports as
 * `/private/var` and `/private/tmp`. Longest first, so the fuller spelling
 * is taken before the one inside it. Asked once, where a process starts;
 * `stripForgeDirs` is then given the answer for each line.
 */
export function spellings(dirs: readonly string[]): string[] {
  const all = new Set<string>();
  for (const dir of dirs) {
    if (dir === "") continue;
    all.add(dir);
    try {
      all.add(realpathSync(dir));
    } catch {
      // Not there yet, or not ours to resolve: its own spelling is all.
    }
  }
  return [...all].sort((a, b) => b.length - a.length);
}
