/**
 * How much of a followed source's diff a head carries (#9034).
 *
 * A merge commit names the source's tip as a parent whatever tree it
 * records: `git merge -s ours` marks every commit of the source as merged
 * and brings none of them, and git never offers them again. So the share is
 * read from the trees, never from ancestry: the source's diff is what its
 * tip changed since the fork point from the base, and what the head still
 * lacks of it is what it dropped. Lines are `added + removed`, as
 * `git diff --numstat` counts them (a binary file counts one).
 */
import { runGitCapture } from "./env.ts";
import { isSafeOid } from "./guard.ts";

/** A head must carry at least this share of a source's lines, or a person decides. */
export const MIN_SHARE = 0.8;

export interface SourceShare {
  /** The source's commit the head actually merged: its tip, or an older one the source has since moved past. */
  readonly tip: string;
  readonly commits: { readonly dropped: number; readonly of: number };
  readonly files: { readonly dropped: number; readonly of: number };
  readonly lines: { readonly dropped: number; readonly of: number };
  /** Lines brought over lines in the source's diff; 1 when that diff is empty. */
  readonly share: number;
}

/** `git diff --numstat -z` read as path → lines changed; undefined when git could not say. */
async function numstat(dir: string, from: string, to: string): Promise<Map<string, number> | undefined> {
  const out = await runGitCapture(["diff", "--numstat", "-z", "--no-renames", from, to, "--"], { cwd: dir });
  if (out.code !== 0) return undefined;
  const lines = new Map<string, number>();
  for (const entry of out.stdout.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (m === null) continue;
    lines.set(m[3]!, m[1] === "-" ? 1 : Number(m[1]) + Number(m[2]));
  }
  return lines;
}

/**
 * What `head` carries of the source's diff since `shared`, the fork point
 * from the base. The diff runs to the commit of the source the head merged,
 * not to the source's current tip: an `-s ours` merge made before the source
 * moved on must be measured as well. That commit is the newest one the head
 * and the source share (their merge base). Undefined when the head merged
 * nothing of the source the base lacks, or when git could not say.
 */
export async function sourceShare(
  dir: string,
  base: string,
  head: string,
  current: string,
): Promise<SourceShare | undefined> {
  if (![base, head, current].every(isSafeOid)) return undefined;
  const common = await runGitCapture(["merge-base", current, head], { cwd: dir });
  if (common.code !== 0) return undefined;
  const tip = common.stdout.trim();
  if (!isSafeOid(tip)) return undefined;
  const held = await runGitCapture(["merge-base", "--is-ancestor", tip, base], { cwd: dir });
  if (held.code === 0) return undefined;
  const fork = await runGitCapture(["merge-base", tip, base], { cwd: dir });
  if (fork.code !== 0) return undefined;
  const shared = fork.stdout.trim();
  if (!isSafeOid(shared)) return undefined;

  const theirs = await numstat(dir, shared, tip);
  const missing = await numstat(dir, head, tip);
  if (theirs === undefined || missing === undefined) return undefined;

  // The head's difference from the tip, in the files the source changed: what it left out.
  const droppedIn = new Map<string, number>();
  for (const [path, total] of theirs) {
    const left = missing.get(path) ?? 0;
    if (left > 0) droppedIn.set(path, Math.min(total, left));
  }
  const total = [...theirs.values()].reduce((a, b) => a + b, 0);
  const dropped = [...droppedIn.values()].reduce((a, b) => a + b, 0);

  // A commit is dropped when every file it touches is.
  const log = await runGitCapture(
    ["-c", "core.quotepath=false", "log", "--no-merges", "--no-renames", "--name-only", "--format=%x01%H", `${shared}..${tip}`],
    { cwd: dir },
  );
  let of = 0;
  let gone = 0;
  if (log.code === 0)
    for (const block of log.stdout.split("\x01").slice(1)) {
      const files = block.split("\n").slice(1).filter((f) => f !== "");
      of++;
      if (files.length > 0 && files.every((f) => droppedIn.has(f))) gone++;
    }

  return {
    tip,
    commits: { dropped: gone, of },
    files: { dropped: droppedIn.size, of: theirs.size },
    lines: { dropped, of: total },
    share: total === 0 ? 1 : (total - dropped) / total,
  };
}

/** What a pull dropped of a source, in the words a person reads: commits, files, lines. */
export const droppedWords = (s: SourceShare): string =>
  `${s.commits.dropped} of ${s.commits.of} commits, ${s.files.dropped} of ${s.files.of} files, ${s.lines.dropped} of ${s.lines.of} lines`;
