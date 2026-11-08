/**
 * An issue, or a comment on one, as its origin currently shows it.
 *
 * The origin's webhook (`origins/hook.ts`) names an issue or pull number and
 * this reads the whole thread again; the sync sweep does the same for what
 * moved while no delivery came (`sync.ts`). Both land in `importIssue` and
 * `importComments`, which key on the origin's own ids, so a comment that
 * arrives twice (the delivery, then the catch-up; or our own write-through,
 * then its echo) is one row.
 */

import type { Database } from "bun:sqlite";
import { importComments, importIssue } from "./import.ts";
import type { Provider } from "./types.ts";

/**
 * Answers whether the origin spoke; `"pull"` when the number is a pull, which
 * is left alone here (`pull-check.ts` owns pulls, and importing one through
 * this path would make a stray issue row). An origin that does not speak
 * leaves the rows as they were.
 */
export async function refreshOriginItem(
  ctx: { db: Database; repoId: string; actorId: string },
  provider: Provider,
  fullName: string,
  number: number,
): Promise<boolean | "pull"> {
  const remote = await provider.getIssue(fullName, number);
  if (!remote.ok) return false;
  if (remote.value.pull !== undefined) return "pull";
  const imported = importIssue(ctx, remote.value);
  const comments = await provider.listComments(fullName, number);
  if (!comments.ok) return false;
  importComments(ctx, imported.issueId, comments.value);
  return true;
}
