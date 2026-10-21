/**
 * A client's apps and how busy their agents are (#1812): one row per app on
 * the forge made for them, with the agent runs going and the ones lined up.
 * The web home and the terminal both read it, so they cannot disagree.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { ago } from "../feed/rank.ts";
import { spawnedRepos } from "./next-steps.ts";
import { withoutArchived, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

export interface ClientApp {
  readonly repo: Repo;
  /** Agent runs going now. */
  readonly working: number;
  /** Agent runs lined up, none going yet. */
  readonly queued: number;
}

/** The apps `user` can see on a spawned forge, each with its agent counts; archived ones are put away, not shown. */
export async function clientAppRows(
  app: App,
  user: User,
): Promise<readonly ClientApp[]> {
  const repos = withoutArchived(await spawnedRepos(app, user));
  if (repos.length === 0) return [];
  const rows = app.db
    .query<{ repo_id: string; state: string; n: number }, string[]>(
      `SELECT repo_id, state, COUNT(*) AS n FROM run
       WHERE kind = 'agent' AND state IN ('queued','running')
         AND repo_id IN (${repos.map((_, i) => `?${i + 1}`).join(",")})
       GROUP BY repo_id, state`,
    )
    .all(...repos.map((r) => r.id));
  return repos.map((repo) => {
    const own = rows.filter((r) => r.repo_id === repo.id);
    const n = (state: string): number =>
      own.find((r) => r.state === state)?.n ?? 0;
    return { repo, working: n("running"), queued: n("queued") };
  });
}

/** What one app's agents are doing, in words a client can read. */
export type ClientDoing =
  | { readonly kind: "working"; readonly title: string }
  | { readonly kind: "landed"; readonly title: string; readonly at: string };

const WEEK_MS = 7 * 24 * 3600 * 1000;

/**
 * For each of `appIds` (repo ids), the title of the work running now, else of
 * the last change landed in the 7 days before `now`; an app with neither is
 * left out. One query, at most one row per app.
 */
export function clientDoings(
  db: Database,
  appIds: readonly string[],
  now: Date,
): ReadonlyMap<string, ClientDoing> {
  const doings = new Map<string, ClientDoing>();
  if (appIds.length === 0) return doings;
  const marks = appIds.map((_, i) => `?${i + 3}`).join(",");
  const rows = db
    .query<
      { repo_id: string; kind: string; title: string; at: string },
      (string | number)[]
    >(
      `SELECT repo_id, kind, title, at FROM (
         SELECT repo_id, kind, title, at,
                ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY rank, at DESC) AS n
         FROM (
           SELECT r.repo_id AS repo_id, 'working' AS kind, i.title AS title,
                  COALESCE(r.started_at, r.created_at) AS at, 0 AS rank
           FROM run r JOIN issue i ON i.id = r.issue_id
           WHERE r.kind = 'agent' AND r.state = 'running'
             AND r.repo_id IN (${marks})
           UNION ALL
           SELECT i.repo_id, 'landed', i.title, p.merged_at, 1
           FROM issue i JOIN pull p ON p.issue_id = i.id
           WHERE i.kind = 'pull' AND i.state = 'closed'
             AND i.repo_id IN (${marks}) AND p.merged_at >= ?1
         )
       ) WHERE n = 1 LIMIT ?2`,
    )
    .all(new Date(now.getTime() - WEEK_MS).toISOString(), appIds.length, ...appIds);
  for (const row of rows) {
    doings.set(
      row.repo_id,
      row.kind === "working"
        ? { kind: "working", title: row.title }
        : { kind: "landed", title: row.title, at: row.at },
    );
  }
  return doings;
}

const TITLE_MAX = 80;

/** `title` cut to 80 characters at a word boundary, with "…" when anything was dropped. */
export function cutTitle(title: string): string {
  const text = title.replace(/\s+/g, " ").trim();
  if (text.length <= TITLE_MAX) return text;
  const head = text.slice(0, TITLE_MAX - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The sentence about what an app's agents are on, or "" for a quiet app. */
export function doingLine(doing: ClientDoing | undefined, now: number): string {
  if (!doing) return "";
  const title = cutTitle(doing.title);
  if (title === "") return "";
  switch (doing.kind) {
    case "working":
      return `Working on: ${title}`;
    case "landed":
      return `Last change: ${title}, ${ago(Date.parse(doing.at), now)}`;
  }
}
