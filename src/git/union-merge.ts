/**
 * Three versions of one text file merged with `git merge-file --union`: a
 * clash keeps both sides' lines instead of leaving markers. For a file whose
 * content is a list, where two pulls each add an entry at the same place.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGitCapture } from "./env.ts";
import { isSafeOid, isSafeTreePath } from "./guard.ts";

const MAX_BYTES = 1_000_000;

/**
 * The files a pull's conflict is settled in without a run. Only files that
 * are line-lists, where each pull adds its own entry: `--union` keeps both
 * sides' lines unreviewed, which is right for two table rows or bullets and
 * wrong for prose, where it would duplicate or interleave paragraphs.
 * docs/MCP.md is mostly bullets; README.md and CHANGELOG.md hold
 * sections of prose and stay with a run.
 */
export const LIST_DOCS: readonly string[] = ["docs/MCP.md"];

export const isListDoc = (path: string): boolean => LIST_DOCS.includes(path);

async function blobAt(dir: string, oid: string, path: string): Promise<string | undefined> {
  const out = await runGitCapture(["cat-file", "blob", `${oid}:${path}`], { cwd: dir });
  return out.code === 0 && out.stdout.length <= MAX_BYTES ? out.stdout : undefined;
}

/**
 * `path` at `ours` and `theirs`, merged over what they share at `base`, both
 * sides kept. Undefined when the file is missing on any side or too large.
 */
export async function unionMergeFile(
  dir: string,
  base: string,
  ours: string,
  theirs: string,
  path: string,
): Promise<string | undefined> {
  if (!isSafeOid(base) || !isSafeOid(ours) || !isSafeOid(theirs) || !isSafeTreePath(path))
    return undefined;
  const [b, o, t] = await Promise.all([
    blobAt(dir, base, path),
    blobAt(dir, ours, path),
    blobAt(dir, theirs, path),
  ]);
  if (b === undefined || o === undefined || t === undefined) return undefined;
  const work = await mkdtemp(join(tmpdir(), "forge-union-"));
  try {
    await Promise.all([
      writeFile(join(work, "ours"), o),
      writeFile(join(work, "base"), b),
      writeFile(join(work, "theirs"), t),
    ]);
    const merged = await runGitCapture(
      ["merge-file", "-p", "--union", join(work, "ours"), join(work, "base"), join(work, "theirs")],
      { cwd: dir },
    );
    // Exit 0 is clean; a positive count is the clashes kept as both sides.
    return merged.code >= 0 && merged.code < 128 ? merged.stdout : undefined;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
