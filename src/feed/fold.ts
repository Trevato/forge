/**
 * The fold: one author's burst of the same kind of post in one repository
 * becomes one post with a line under it for each. One function, one table;
 * a new kind of burst is a new row in `FOLDS`, a `fold` on its candidates.
 */

import type { Candidate } from "./items.ts";

export interface FoldRule {
  /** The folded post reads `<verb> N <noun> in owner/name`. */
  readonly verb: string;
  readonly noun: string;
  /** How many make a burst; fewer keep their own posts. */
  readonly min: number;
  /** A burst is everything within this long of its first. */
  readonly windowMs: number;
  /** Titles shown under the post; the rest are `and N more`. */
  readonly shown: number;
  /** Where the folded post links, from the repository's path. */
  readonly link: (repoPath: string) => string;
}

export const FOLDS: Readonly<Record<string, FoldRule>> = {
  issues: {
    verb: "planned",
    noun: "issues",
    min: 3,
    windowMs: 2 * 60_000,
    shown: 3,
    link: (repo) => `${repo}/map`,
  },
};

/** A candidate that may fold: which rule, and its own line. */
export interface Foldable {
  readonly group: string;
  readonly title: string;
}

/**
 * Replaces each burst with one candidate that ranks where its newest member
 * would (its time) and keeps the rest as they were, in order.
 */
export function foldBursts(candidates: readonly Candidate[]): Candidate[] {
  const buckets = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.fold === undefined || c.actorId === null) continue;
    const key = `${c.fold.group}|${c.repoId}|${c.actorId}`;
    const list = buckets.get(key);
    if (list) list.push(c);
    else buckets.set(key, [c]);
  }
  const folded = new Map<string, Candidate>();
  const gone = new Set<string>();
  for (const [key, list] of buckets) {
    const rule = FOLDS[key.slice(0, key.indexOf("|"))];
    if (rule === undefined) continue;
    const sorted = [...list].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : 1),
    );
    let burst: Candidate[] = [];
    const close = () => {
      if (burst.length >= rule.min) {
        const newest = burst[burst.length - 1]!;
        for (const c of burst) gone.add(c.id);
        folded.set(newest.id, join(burst, newest, rule));
      }
      burst = [];
    };
    for (const c of sorted) {
      if (
        burst.length > 0 &&
        Date.parse(c.at) - Date.parse(burst[0]!.at) > rule.windowMs
      )
        close();
      burst.push(c);
    }
    close();
  }
  const out: Candidate[] = [];
  for (const c of candidates) {
    const one = folded.get(c.id);
    if (one) out.push(one);
    else if (!gone.has(c.id)) out.push(c);
  }
  return out;
}

function join(burst: Candidate[], newest: Candidate, rule: FoldRule): Candidate {
  // Newest first, as the feed shows them.
  const lines = [...burst].reverse().map((c) => ({ text: c.fold!.title, link: c.link }));
  const { fold: _fold, ...rest } = newest;
  return {
    ...rest,
    // The first member's id: it does not move as the burst grows, so a dismissal holds.
    id: `fold:${burst[0]!.id.replace(/^[a-z]+:/, "")}`,
    link: rule.link(`/${newest.app}`),
    what: `${rule.verb} ${burst.length} ${rule.noun} in ${newest.app}`,
    lines: lines.slice(0, rule.shown),
    more: Math.max(0, lines.length - rule.shown),
  };
}
