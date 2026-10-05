/**
 * A repository's pillars (#612): what its direction says the work is for,
 * read from the issues that stand for them. Nothing is stored. A pillar is
 * an open umbrella issue whose title starts with its name, `P0 Trust: …`,
 * and an issue serves the pillar whose umbrella waits for it. Work that
 * serves none waits behind the Later gate, the open issue whose title starts
 * `Later gate:`, and stands under the Later umbrella (`Later: …`) where the
 * repository keeps one.
 *
 * A title is not enough, because anyone who may open an issue may write one.
 * An issue stands for a pillar, the gate or the Later umbrella only when a
 * person who writes the repository opened it here: not an agent, not someone
 * who can only read, and not an issue imported from an origin under another
 * name. So a stranger's "P0 …" on a public repository makes no pillar, and
 * their "Later gate: …" holds nothing and opens nothing.
 *
 * A repository with no such issues has no pillars, and plans as it always
 * did.
 */

import type { Database } from "bun:sqlite";
import { getIssuesByIds, type Issue } from "./issues.ts";
import { canWrite, type Repo } from "./repos.ts";
import { getUserById } from "./users.ts";

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

/** An open issue, written here by a person, that is titled like an umbrella or the gate. */
const TITLED = `issue.repo_id = ?1 AND issue.kind = 'issue' AND issue.state = 'open'
  AND issue.origin_author IS NULL
  AND (issue.title GLOB 'P[0-9]*' OR issue.title LIKE 'Later%')`;

/** The pillars, the Later gate and the Later umbrella of one repository. */
export function pillarsOf(db: Database, repo: Repo): Pillars {
  // Who among the people that opened such an issue writes the repository.
  // Asked per author, not per issue, and before the cap: however many
  // issues a stranger opens, none of them takes a real umbrella's place.
  const writers = db
    .query<{ id: string }, [string]>(
      `SELECT DISTINCT issue.author_id AS id
         FROM issue JOIN user ON user.id = issue.author_id
        WHERE ${TITLED} AND user.kind = 'user' AND user.is_agent = 0`,
    )
    .all(repo.id)
    .map((row) => row.id)
    .filter((id) => canWrite(db, repo, getUserById(db, id)));
  if (writers.length === 0)
    return { pillars: [], gate: undefined, later: undefined };
  const ids = db
    .query<{ id: string }, (string | number)[]>(
      `SELECT issue.id FROM issue
        WHERE ${TITLED}
          AND issue.author_id IN (${writers.map((_, i) => `?${i + 3}`).join(",")})
        ORDER BY issue.number LIMIT ?2`,
    )
    .all(repo.id, MAX, ...writers)
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
