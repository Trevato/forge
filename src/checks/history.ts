/**
 * The commits a fast tier diffs and reads, inside the check's clone. A
 * check's checkout is a bare export of one tree (`apps/checkout.ts`): no
 * history, no `origin/main`. This gives it the base as one shallow commit and
 * the head with every commit the pull adds, so `git diff $FORGE_CHECK_BASE..HEAD`
 * and `git log $FORGE_CHECK_BASE..HEAD` answer there. A head fetched one deep
 * showed the gate only its last message, so a `Try:` line in an earlier commit
 * of the pull was invisible once a main merge landed on top of it.
 */

import { runGit } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";

/** Most commits of a pull's own history the check fetches: past this, only the newest. */
export const MAX_PULL_COMMITS = 500;

/** How deep to fetch the head so every commit in `base..head` arrives (at least 1). */
async function headDepth(bare: string, base: string, head: string): Promise<number> {
  const counted = await runGit(["rev-list", "--count", `${base}..${head}`], { cwd: bare, timeoutMs: 30_000 });
  const n = counted.ok ? Number.parseInt(counted.value.trim(), 10) : NaN;
  // Unknown (a base the bare lacks) keeps the old one-deep fetch: the diff still answers.
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PULL_COMMITS);
}

export async function giveHistory(
  bare: string,
  dir: string,
  base: string,
  head: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isSafeOid(base) || !isSafeOid(head))
    return { ok: false, error: "not a commit id" };
  // A commit of the pull is never farther than the pull's own count from its
  // head (every commit between them is the pull's too), so that depth brings all of them.
  const depth = await headDepth(bare, base, head);
  for (const args of [
    ["init", "--quiet"],
    ["fetch", "--quiet", "--no-tags", "--depth=1", bare, base],
    ["fetch", "--quiet", "--no-tags", `--depth=${depth}`, bare, head],
    ["update-ref", "HEAD", head],
  ]) {
    const done = await runGit(args, { cwd: dir, timeoutMs: 120_000 });
    if (!done.ok)
      return { ok: false, error: `${args[0]}: ${done.error.stderr || "failed"}` };
  }
  return { ok: true };
}
