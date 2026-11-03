/**
 * Slices of a pull (#9010): a long pull lands as several true merges, each
 * of one of the author's own commits — never rewritten, so every commit of
 * theirs becomes an ancestor of the base and their next `git merge` of it is
 * clean. A slice's merge commit carries a `Slice-of: #N` trailer; which
 * slices landed is read back from the base's history, not stored apart.
 */

import { runGit } from "./env.ts";
import { isSafeOid, isSafeRef } from "./guard.ts";

/** The trailer a slice's merge commit carries. */
export function sliceTrailer(number: number): string {
  return `Slice-of: #${number}`;
}

/** Where a slice may end: a commit of the pull's that the base does not hold yet. */
export async function sliceEndOk(
  dir: string,
  baseOid: string,
  headOid: string,
  upTo: string,
): Promise<boolean> {
  if (!isSafeOid(baseOid) || !isSafeOid(headOid) || !isSafeOid(upTo)) return false;
  const inHead = await runGit(["merge-base", "--is-ancestor", upTo, headOid], { cwd: dir });
  if (!inHead.ok) return false;
  const onBase = await runGit(["merge-base", "--is-ancestor", upTo, baseOid], { cwd: dir });
  return !onBase.ok;
}

export interface LandedSlice {
  /** The merge commit on the base. */
  readonly mergeOid: string;
  /** The author's commit it merged, as it was. */
  readonly upTo: string;
}

/**
 * The slices of pull `number` on the base, oldest first: merge commits on
 * its first-parent line since the pull opened that carry its trailer.
 */
export async function landedSlices(
  dir: string,
  baseRef: string,
  number: number,
  since: string,
): Promise<LandedSlice[]> {
  if (!Number.isInteger(number) || number < 1) return [];
  if (!isSafeOid(baseRef) && !isSafeRef(baseRef)) return [];
  const at = Date.parse(since);
  const out = await runGit(
    [
      "log",
      "--first-parent",
      "--merges",
      "--max-count=100",
      ...(Number.isFinite(at) ? [`--since=${Math.floor(at / 1000) - 60}`] : []),
      `--grep=^${sliceTrailer(number)}$`,
      "--format=%H %P",
      baseRef,
      "--",
    ],
    { cwd: dir },
  );
  if (!out.ok) return [];
  const slices: LandedSlice[] = [];
  for (const line of out.value.split("\n")) {
    const [mergeOid, , upTo] = line.trim().split(" ");
    if (mergeOid !== undefined && upTo !== undefined && isSafeOid(mergeOid) && isSafeOid(upTo))
      slices.push({ mergeOid, upTo });
  }
  return slices.reverse();
}

/**
 * Where a slice may end, oldest first: the author's line of commits
 * (first parent) the base lacks — the oldest `limit - 1` of them, then the
 * head, which is the last slice.
 */
export async function sliceEnds(
  dir: string,
  baseOid: string,
  headOid: string,
  limit = 100,
): Promise<{ oid: string; subject: string }[]> {
  if (!isSafeOid(baseOid) || !isSafeOid(headOid)) return [];
  const out = await runGit(
    ["log", "--first-parent", "--max-count=2000", "--format=%H %s", `${baseOid}..${headOid}`, "--"],
    { cwd: dir },
  );
  if (!out.ok) return [];
  const all = out.value
    .split("\n")
    .map((line) => ({ oid: line.slice(0, line.indexOf(" ")), subject: line.slice(line.indexOf(" ") + 1) }))
    .filter((c) => isSafeOid(c.oid));
  if (all.length === 0) return [];
  const [head, ...older] = all;
  return [...older.reverse().slice(0, limit - 1), head!];
}
