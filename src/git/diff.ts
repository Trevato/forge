/**
 * Diffs, as a structured model the UI can render however it likes. We ask
 * real git for the diff (its rename detection and histogram hunks are years
 * of work we will not reimplement) and parse the unified text into files,
 * hunks, and line-numbered rows. Correctness from git, shape for us.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { diffMemoryKey, recalled, remember } from "./diff-memory.ts";
import { runGitRaw, type GitFailure } from "./env.ts";
import { isSafeOid, isSafeRef } from "./guard.ts";

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied";
export type LineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: LineKind;
  /** 1-based line number in the old blob, or null on an added line. */
  readonly oldNumber: number | null;
  /** 1-based line number in the new blob, or null on a deleted line. */
  readonly newNumber: number | null;
  readonly content: string;
  /** The "\ No newline at end of file" marker applied to this line. */
  readonly noNewline: boolean;
}

export interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Trailing context after `@@ … @@` — usually the enclosing function. */
  readonly section: string;
  readonly lines: DiffLine[];
}

export interface FileDiff {
  readonly status: FileStatus;
  /** Path in the old tree; null when added. */
  readonly oldPath: string | null;
  /** Path in the new tree; null when deleted. */
  readonly newPath: string | null;
  /** The path to show and link by (new side, falling back to old). */
  readonly path: string;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  /** Rename/copy similarity percentage when git reported one. */
  readonly similarity: number | null;
  readonly hunks: Hunk[];
}

export interface Diff {
  readonly files: FileDiff[];
  readonly additions: number;
  readonly deletions: number;
}

// Common flags for both range and single-commit diffs. `diff` and
// `diff-tree` share these; only the sub-command and revs differ.
const DIFF_FLAGS = ["--no-color", "--histogram", "--find-renames"] as const;

function safeRange(...revs: string[]): boolean {
  return revs.every((r) => isSafeOid(r) || isSafeRef(r));
}

/** Diff between two revisions (base..head), i.e. what head adds over base. */
export async function diffRange(
  dir: string,
  base: string,
  head: string,
  laps?: DiffLaps,
): Promise<Result<Diff, GitFailure | "unsafe_rev">> {
  if (!safeRange(base, head)) return err("unsafe_rev");
  // `git diff A B` compares two tree-ish and needs no work tree.
  const run = () => runDiff(dir, ["diff", ...DIFF_FLAGS, base, head, "--"], laps);
  // A ref can move; two object ids cannot, so only their diff is remembered.
  if (!isSafeOid(base) || !isSafeOid(head)) return run();
  const key = diffMemoryKey(dir, base, head);
  const known = recalled(key);
  if (known !== undefined) return ok(known);
  // Readers arriving while git runs wait for that run rather than start one.
  const pending = running.get(key);
  if (pending !== undefined) return pending;
  const started = run().then((result) => (result.ok ? ok(remember(key, result.value)) : result));
  running.set(key, started);
  try {
    return await started;
  } finally {
    running.delete(key);
  }
}

/** Range diffs git is producing right now, by memory key. */
const running = new Map<string, Promise<Result<Diff, GitFailure>>>();

/** Diff a commit against its first parent (or the empty tree for a root). */
export async function diffCommit(
  dir: string,
  oid: string,
): Promise<Result<Diff, GitFailure | "unsafe_rev">> {
  if (!safeRange(oid)) return err("unsafe_rev");
  // diff-tree is the bare-repo plumbing: no work tree, --root diffs a first
  // commit against the empty tree, -m --first-parent handles merges. It
  // prints a leading commit-oid line the parser harmlessly skips.
  return runDiff(dir, [
    "diff-tree",
    "-p",
    "-r",
    "--root",
    "-m",
    "--first-parent",
    ...DIFF_FLAGS,
    oid,
    "--",
  ]);
}

/** Where a diff's time went, in ms: git's own run and our parse of its text. */
export interface DiffLaps {
  git?: number;
  parse?: number;
}

async function runDiff(
  dir: string,
  args: readonly string[],
  laps?: DiffLaps,
): Promise<Result<Diff, GitFailure>> {
  const started = performance.now();
  const raw = await runGitRaw(args, { cwd: dir, timeoutMs: 60_000 });
  const parsing = performance.now();
  if (laps) laps.git = (laps.git ?? 0) + parsing - started;
  if (!raw.ok) return raw;
  const diff = parseUnifiedDiff(new TextDecoder().decode(raw.value));
  if (laps) laps.parse = (laps.parse ?? 0) + performance.now() - parsing;
  return ok(diff);
}

// ---- the parser ----
//
// git's unified format, per file:
//   diff --git a/old b/new
//   (old mode / new mode / similarity / rename|copy from|to / index …)*
//   --- a/old            (or /dev/null)
//   +++ b/new            (or /dev/null)
//   @@ -s,n +s,n @@ section
//   [ +-\\]lines…
// or, in place of the ---/+++/@@ body:
//   Binary files a/old and b/new differ

export function parseUnifiedDiff(text: string): Diff {
  const files: FileDiff[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    if (!lines[i]!.startsWith("diff --git ")) {
      i++;
      continue;
    }
    const parsed = parseFile(lines, i);
    files.push(parsed.file);
    i = parsed.next;
  }

  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files, additions, deletions };
}

function parseFile(
  lines: string[],
  start: number,
): { file: FileDiff; next: number } {
  const header = lines[start]!;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let status: FileStatus = "modified";
  let binary = false;
  let similarity: number | null = null;
  const hunks: Hunk[] = [];

  // Fallback paths from the `diff --git a/x b/y` line (handles most names;
  // the authoritative ---/+++ lines below override when present).
  const headerPaths = header.slice("diff --git ".length);
  const guess = splitHeaderPaths(headerPaths);
  if (guess) {
    oldPath = guess.a;
    newPath = guess.b;
  }

  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) break;

    if (line.startsWith("new file mode")) status = "added";
    else if (line.startsWith("deleted file mode")) status = "deleted";
    else if (line.startsWith("rename from ")) {
      status = "renamed";
      oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to "))
      newPath = line.slice("rename to ".length);
    else if (line.startsWith("copy from ")) {
      status = "copied";
      oldPath = line.slice("copy from ".length);
    } else if (line.startsWith("copy to "))
      newPath = line.slice("copy to ".length);
    else if (line.startsWith("similarity index ")) {
      similarity =
        Number(line.slice("similarity index ".length).replace("%", "")) || null;
    } else if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      binary = true;
      // Binary files have no ---/+++ markers, so the header split (which
      // defers on quoted names) may have left the paths null. Recover them
      // from the "Binary files a/X and b/Y differ" line.
      const m = line.match(/^Binary files (.+) and (.+) differ$/);
      if (m) {
        const a = pathFromMarker(m[1]!);
        const b = pathFromMarker(m[2]!);
        if (oldPath === null && a !== null) oldPath = a;
        if (newPath === null && b !== null) newPath = b;
      }
    } else if (line.startsWith("--- ")) {
      const p = pathFromMarker(line.slice(4));
      oldPath = p; // /dev/null → null (an addition)
      if (p === null && status === "modified") status = "added";
    } else if (line.startsWith("+++ ")) {
      const p = pathFromMarker(line.slice(4));
      newPath = p; // /dev/null → null (a deletion)
      if (p === null && status === "modified") status = "deleted";
    } else if (line.startsWith("@@")) {
      const hunk = parseHunk(lines, i);
      hunks.push(hunk.hunk);
      i = hunk.next - 1; // loop's i++ steps to the next line
    }
  }

  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.kind === "add") additions++;
      else if (l.kind === "del") deletions++;
    }
  }

  const path = newPath ?? oldPath ?? "(unknown)";
  return {
    file: {
      status,
      oldPath,
      newPath,
      path,
      binary,
      additions,
      deletions,
      similarity,
      hunks,
    },
    next: i,
  };
}

function parseHunk(
  lines: string[],
  start: number,
): { hunk: Hunk; next: number } {
  // @@ -oldStart,oldLines +newStart,newLines @@ section
  const match = lines[start]!.match(
    /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+(.*)$/,
  );
  const oldStart = match ? Number(match[1]) : 0;
  const oldLines = match ? (match[2] === undefined ? 1 : Number(match[2])) : 0;
  const newStart = match ? Number(match[3]) : 0;
  const newLines = match ? (match[4] === undefined ? 1 : Number(match[4])) : 0;
  const section = match ? (match[5] ?? "").replace(/^ /, "") : "";

  const rows: DiffLine[] = [];
  let oldNo = oldStart;
  let newNo = newStart;
  let i = start + 1;

  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line[0];
    if (marker === "\\") {
      // "\ No newline at end of file" annotates the row just emitted.
      const last = rows[rows.length - 1];
      if (last) rows[rows.length - 1] = { ...last, noNewline: true };
      continue;
    }
    if (marker === "@" || line.startsWith("diff --git ")) break;
    if (marker !== " " && marker !== "+" && marker !== "-") break;

    const content = line.slice(1);
    if (marker === "+") {
      rows.push({
        kind: "add",
        oldNumber: null,
        newNumber: newNo++,
        content,
        noNewline: false,
      });
    } else if (marker === "-") {
      rows.push({
        kind: "del",
        oldNumber: oldNo++,
        newNumber: null,
        content,
        noNewline: false,
      });
    } else {
      rows.push({
        kind: "context",
        oldNumber: oldNo++,
        newNumber: newNo++,
        content,
        noNewline: false,
      });
    }
  }

  return {
    hunk: { oldStart, oldLines, newStart, newLines, section, lines: rows },
    next: i,
  };
}

/** `a/path` → `path`; `/dev/null` → null. Handles quoted C-style names. */
function pathFromMarker(raw: string): string | null {
  const cleaned = raw.replace(/\t.*$/, "");
  if (cleaned === "/dev/null") return null;
  const unquoted = unquotePath(cleaned);
  return unquoted.replace(/^[ab]\//, "");
}

/** Split `a/old b/new` from the `diff --git` line. Best-effort for the
 * common unquoted case; the ---/+++ markers are authoritative otherwise. */
function splitHeaderPaths(text: string): { a: string; b: string } | null {
  if (text.startsWith('"')) return null; // quoted: defer to ---/+++
  // Paths share a length in the common case: `a/x b/x`. Find " b/" splitting.
  const marker = text.indexOf(" b/");
  if (marker === -1) return null;
  return {
    a: text.slice(0, marker).replace(/^a\//, ""),
    b: text.slice(marker + 1).replace(/^b\//, ""),
  };
}

/**
 * Decode git's C-style quoting of paths with special characters. Non-ASCII
 * bytes are octal-escaped one byte at a time, so we collect the raw bytes and
 * decode the whole run as UTF-8 once — decoding each escape as its own code
 * unit turns any multi-byte name into mojibake.
 */
function unquotePath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    "\\": 0x5c,
    '"': 0x22,
    n: 0x0a,
    t: 0x09,
    r: 0x0d,
    b: 0x08,
    f: 0x0c,
    v: 0x0b,
    a: 0x07,
  };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== "\\") {
      // Literal char (ASCII in quoted paths); encode defensively as UTF-8.
      const code = c.charCodeAt(0);
      if (code < 0x80) bytes.push(code);
      else for (const b of new TextEncoder().encode(c)) bytes.push(b);
      continue;
    }
    const next = inner[i + 1];
    if (next !== undefined && next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (
        j < inner.length &&
        oct.length < 3 &&
        inner[j]! >= "0" &&
        inner[j]! <= "7"
      )
        oct += inner[j++];
      bytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
    } else if (next !== undefined && next in simple) {
      bytes.push(simple[next]!);
      i++;
    } else if (next !== undefined) {
      bytes.push(next.charCodeAt(0));
      i++;
    }
  }
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}
