/**
 * The two commits a fast tier diffs, inside the check's clone. A check's
 * checkout is a bare export of one tree (`apps/checkout.ts`): no history, no
 * `origin/main`. This gives it a repository of two shallow commits, so
 * `git diff $FORGE_CHECK_BASE..HEAD` answers there and nowhere else.
 */

import { runGit } from "../git/env.ts";
import { isSafeOid } from "../git/guard.ts";

export async function giveHistory(
  bare: string,
  dir: string,
  base: string,
  head: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isSafeOid(base) || !isSafeOid(head))
    return { ok: false, error: "not a commit id" };
  for (const args of [
    ["init", "--quiet"],
    ["fetch", "--quiet", "--no-tags", "--depth=1", bare, base, head],
    ["update-ref", "HEAD", head],
  ]) {
    const done = await runGit(args, { cwd: dir, timeoutMs: 120_000 });
    if (!done.ok)
      return { ok: false, error: `${args[0]}: ${done.error.stderr || "failed"}` };
  }
  return { ok: true };
}
