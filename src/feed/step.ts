/**
 * Where a pull's post stands on the one path (#7703): check, review, land
 * or live, from `stepOfStored` — the same function the pull page reads.
 * Only posts whose link is a pull have one; a pull closed unmerged has none.
 */

import type { Database } from "bun:sqlite";
import { getRepo } from "../core/repos.ts";
import { stepOfNumber, type PathStep } from "../flow/path.ts";

const PULL = /^\/([^/]+)\/([^/]+)\/pulls\/(\d{1,9})$/;

export function stepsOf(
  db: Database,
  posts: readonly { readonly id: string; readonly kind: string; readonly link: string }[],
): Map<string, PathStep> {
  const out = new Map<string, PathStep>();
  for (const p of posts) {
    const m = p.kind === "pull" ? PULL.exec(p.link) : null;
    if (m === null) continue;
    const repo = getRepo(db, m[1]!, m[2]!);
    const step = repo ? stepOfNumber(db, repo, Number(m[3])) : null;
    if (step) out.set(p.id, step);
  }
  return out;
}
