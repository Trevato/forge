/**
 * What the crew page and the terminal's crew screen say about the crew's
 * hand-overs: the issues it parked twice and gave to the planner
 * (`parkedTwice`), and the last restore drill. Each is read where its own
 * page reads it, and each is absent when there is nothing to say — an
 * empty card is a zero drawn.
 */

import type { Database } from "bun:sqlite";
import { PARK_LIKE } from "../core/done_on_main.ts";
import { getReposByIds } from "../core/repos.ts";
import { lastDrill } from "../snapshot/drills.ts";
import { clip } from "../text/clip.ts";
import { PARK_STRIKES, parkedTwice } from "./parks.ts";

/** A park reason is cut to this many characters on a card or a terminal row. */
export const REASON_MAX = 140;

export interface HandedRow {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly at: string;
  /** Each park reason, on one line. */
  readonly reasons: readonly string[];
}

export interface DrillLine {
  readonly at: string;
  readonly verdict: "green" | "red";
}

export interface CrewHandover {
  readonly parked: readonly HandedRow[];
  readonly drill: DrillLine | undefined;
}

/** One line, at most `REASON_MAX` code points. */
export function oneLine(reason: string): string {
  return clip(reason, REASON_MAX);
}

/** The issues parked twice in any repository, newest park first. */
export function handedToPlanner(db: Database): HandedRow[] {
  const ids = db
    .query<{ id: string }, []>(
      `SELECT DISTINCT o.repo_id AS id FROM issue o
        WHERE o.kind = 'issue' AND o.state = 'open'
          AND (SELECT COUNT(*) FROM comment p
                WHERE p.issue_id = o.id AND p.body LIKE '${PARK_LIKE}') >= ${PARK_STRIKES}`,
    )
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return [];
  const repos = getReposByIds(db, ids);
  return parkedTwice(db, [...repos.values()])
    .flatMap((p) => {
      const repo = repos.get(p.repoId);
      if (repo === undefined) return [];
      return [
        {
          repo: `${repo.ownerName}/${repo.name}`,
          number: p.number,
          title: p.title,
          at: p.at,
          reasons: p.reasons.map(oneLine),
        },
      ];
    })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export function crewHandover(db: Database): CrewHandover {
  const d = lastDrill(db);
  return {
    parked: handedToPlanner(db),
    drill: d === undefined ? undefined : { at: d.at, verdict: d.verdict },
  };
}
