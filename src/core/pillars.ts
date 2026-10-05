/**
 * A repository's pillars (#612): what its direction says the work is for,
 * read from the issues that stand for them. Nothing is stored. A pillar is
 * an open umbrella issue whose title starts with its name, `P0 Trust: …`,
 * and an issue serves the pillar whose umbrella waits for it. Work that
 * serves none waits behind the Later gate, the open issue whose title starts
 * `Later gate:`, and stands under the Later umbrella (`Later: …`) where the
 * repository keeps one.
 *
 * A repository with no such issues has no pillars, and plans as it always
 * did.
 */

import type { Database } from "bun:sqlite";
import { getIssuesByIds, type Issue } from "./issues.ts";

export interface Pillar {
  /** `P0`. */
  readonly short: string;
  /** `P0 Trust`: the umbrella's title as far as its colon. */
  readonly name: string;
  /** The issue that waits for everything serving this pillar. */
  readonly umbrella: Issue;
}

export interface Pillars {
  /** In the order of their short names; empty where the direction names none. */
  readonly pillars: readonly Pillar[];
  /** What everything deferred waits for. */
  readonly gate: Issue | undefined;
  /** The umbrella deferred work stands under. */
  readonly later: Issue | undefined;
}

const PILLAR = /^(P\d+) [^:]+(?=:)/;
const GATE = /^Later gate:/i;
const LATER = /^Later:/i;
/** More umbrellas than a direction has pillars. */
const MAX = 64;

/** The pillars, the Later gate and the Later umbrella of one repository. */
export function pillarsOf(db: Database, repoId: string): Pillars {
  const ids = db
    .query<{ id: string }, [string, number]>(
      `SELECT id FROM issue
        WHERE repo_id = ?1 AND kind = 'issue' AND state = 'open'
          AND (title GLOB 'P[0-9]*' OR title LIKE 'Later%')
        ORDER BY number LIMIT ?2`,
    )
    .all(repoId, MAX)
    .map((row) => row.id);
  const issues = [...getIssuesByIds(db, ids).values()].sort(
    (a, b) => a.number - b.number,
  );
  const pillars = new Map<string, Pillar>();
  let gate: Issue | undefined;
  let later: Issue | undefined;
  for (const issue of issues) {
    const named = PILLAR.exec(issue.title);
    // The oldest umbrella of a name is the pillar; a second is a duplicate.
    if (named?.[1] !== undefined && !pillars.has(named[1]))
      pillars.set(named[1], {
        short: named[1],
        name: named[0],
        umbrella: issue,
      });
    else if (GATE.test(issue.title)) gate ??= issue;
    else if (LATER.test(issue.title)) later ??= issue;
  }
  return {
    pillars: [...pillars.values()].sort(
      (a, b) => Number(a.short.slice(1)) - Number(b.short.slice(1)),
    ),
    gate,
    later,
  };
}

/** The pillar `text` names, by its short form or its name, in any case. */
export function findPillar(
  pillars: readonly Pillar[],
  text: string,
): Pillar | undefined {
  const wanted = text.trim().toLowerCase();
  return pillars.find(
    (pillar) =>
      pillar.short.toLowerCase() === wanted ||
      pillar.name.toLowerCase() === wanted,
  );
}
