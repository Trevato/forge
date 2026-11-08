/**
 * Who opened the last hour's pulls (#6443): per author, how many pulls opened
 * in the hour before `now`, and how many of those serve a flow issue. A pull
 * serves flow when the issue its description closes (`Closes #N`) is one of
 * the flow issues or carries the `flow` label (any case), or waits on one in the dependency graph, however far.
 * Most first, ties by name. Same `publicOnly` rule as `readVitals`; two reads.
 */

import type { Database } from "bun:sqlite";
import { closesFromBody } from "../core/pulls.ts";

const HOUR_MS = 3_600_000;

/** The flow issues of #5930: flow itself, the freeze, the steward's probe. */
export const FLOW_ISSUES: readonly number[] = [5930, 6217, 5994];

export interface Opener {
  readonly author: string;
  readonly opened: number;
  readonly flow: number;
}

interface PullRow {
  author: string;
  repo_id: string;
  body: string;
}

export function readOpeners(db: Database, now = new Date(), publicOnly = false): Opener[] {
  const to = now.toISOString();
  const from = new Date(now.getTime() - HOUR_MS).toISOString();
  const pub = publicOnly ? 1 : 0;
  const flowRows = db
    .query<{ key: string }, [number, number, number, number]>(
      `WITH RECURSIVE flow(id) AS (
         SELECT i.id FROM issue i JOIN repo r ON r.id = i.repo_id
          WHERE (i.number IN (?1, ?2, ?3)
                 OR EXISTS (SELECT 1 FROM issue_label il JOIN label l ON l.id = il.label_id
                             WHERE il.issue_id = i.id AND l.name = 'flow' COLLATE NOCASE))
            AND (?4 = 0 OR r.visibility = 'public')
         UNION
         SELECT d.issue_id FROM issue_dependency d JOIN flow f ON f.id = d.blocked_by_id
       )
       SELECT i.repo_id || '#' || i.number AS key FROM issue i JOIN flow ON flow.id = i.id`,
    )
    .all(FLOW_ISSUES[0]!, FLOW_ISSUES[1]!, FLOW_ISSUES[2]!, pub);
  const flow = new Set(flowRows.map((r) => r.key));
  const pulls = db
    .query<PullRow, [string, string, number]>(
      `SELECT u.username AS author, i.repo_id AS repo_id, i.body AS body
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = i.author_id
        WHERE i.created_at >= ?1 AND i.created_at <= ?2 AND (?3 = 0 OR r.visibility = 'public')`,
    )
    .all(from, to, pub);
  const by = new Map<string, { opened: number; flow: number }>();
  for (const p of pulls) {
    const t = by.get(p.author) ?? { opened: 0, flow: 0 };
    t.opened++;
    if (closesFromBody(p.body).some((n) => flow.has(`${p.repo_id}#${n}`))) t.flow++;
    by.set(p.author, t);
  }
  return [...by].map(([author, t]) => ({ author, ...t })).sort((a, b) => b.opened - a.opened || a.author.localeCompare(b.author));
}

/** One opener as both doors say it: "scout 4 (3 flow)". */
export const openerCounts = (o: Opener): string => `${o.opened} (${o.flow} flow)`;
