/**
 * A variant group as one feed item: the tell's siblings are one choice, not
 * one post each. While two or more are open and none has shipped it asks the
 * viewer to choose, linking to the deck; once one ships, or all but one
 * close, the item goes: a decided group says nothing. One grouped query, whatever the
 * number of siblings. Only a repository the viewer may write is read — the
 * deck's votes are theirs to cast — and a sealed pull is left out.
 */

import type { Database } from "bun:sqlite";
import type { Repo } from "../core/repos.ts";
import type { Candidate } from "./items.ts";

/** How many groups, newest first, one read looks at. */
export const GROUP_WINDOW = 50;
/** Above the news, below a failure and an ask. */
export const CHOOSE_URGENCY = 3;

const GROUP = /^[A-Za-z0-9_-]{1,64}$/;

interface Row {
  repo_id: string;
  grp: string;
  open: number;
  at: string;
  title: string;
}

export function chooseCandidates(
  db: Database,
  repos: readonly Repo[],
): Candidate[] {
  if (repos.length === 0) return [];
  const byId = new Map(repos.map((r) => [r.id, r]));
  const marks = repos.map((_, i) => `?${i + 1}`).join(",");
  const rows = db
    .query<Row, (string | number)[]>(
      // The bare `title` is the row of MIN(number): the group's first pull.
      `SELECT i.repo_id, p.variant_group AS grp,
              SUM(i.state = 'open') AS open,
              MAX(i.updated_at) AS at,
              i.title, MIN(i.number)
         FROM pull p JOIN issue i ON i.id = p.issue_id
        WHERE i.repo_id IN (${marks}) AND p.variant_group IS NOT NULL
          AND i.sealed = 0
        GROUP BY i.repo_id, p.variant_group
        HAVING SUM(p.merged_at IS NOT NULL) = 0 AND SUM(i.state = 'open') >= 2
        ORDER BY at DESC LIMIT ${GROUP_WINDOW}`,
    )
    .all(...repos.map((r) => r.id));
  const out: Candidate[] = [];
  for (const row of rows) {
    const repo = byId.get(row.repo_id);
    if (!repo || !GROUP.test(row.grp)) continue;
    const title = row.title.length > 60 ? `${row.title.slice(0, 59)}…` : row.title;
    const what = `choose among ${row.open} open variants of “${title}”`;
    out.push({
      id: `choose:${row.grp}`,
      kind: "choose",
      repoId: repo.id,
      app: `${repo.ownerName}/${repo.name}`,
      actorId: null,
      actor: null,
      at: row.at,
      link: `/${repo.ownerName}/${repo.name}/variants/${row.grp}`,
      what,
      urgency: CHOOSE_URGENCY,
      said: what,
    });
  }
  return out;
}
