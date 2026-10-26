/**
 * A client's apps and how busy their agents are (#1812): one row per app on
 * the forge made for them, with the agent runs going and the ones lined up.
 * The web home and the terminal both read it, so they cannot disagree.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { ago } from "../feed/rank.ts";
import { appsRuntime, envsFor } from "../apps/runtime.ts";
import { appsForRepos } from "./apps.ts";
import { spawnedRepos } from "./next-steps.ts";
import { withoutArchived, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

export interface ClientApp {
  readonly repo: Repo;
  /** Agent runs going now. */
  readonly working: number;
  /** Agent runs lined up, none going yet. */
  readonly queued: number;
  /** The address the running app answers at, the apps page's; undefined unless it is running. */
  readonly live: string | undefined;
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
  const runtime = appsRuntime(app);
  const records = appsForRepos(app.db, repos.map((r) => r.id));
  const liveOf = (repo: Repo): string | undefined => {
    const record = records.get(repo.id);
    if (record === undefined || runtime === undefined) return undefined;
    const up = envsFor(app, user, record).find((e) => e.env === "production")?.state === "running";
    return up ? runtime.urlFor(record, "production") : undefined;
  };
  return repos.map((repo) => {
    const own = rows.filter((r) => r.repo_id === repo.id);
    const n = (state: string): number =>
      own.find((r) => r.state === state)?.n ?? 0;
    return { repo, working: n("running"), queued: n("queued"), live: liveOf(repo) };
  });
}

/** What one app's agents are doing now, in words a client can read. */
export interface ClientDoing {
  readonly title: string;
}

/**
 * For each of `appIds` (repo ids), the title of the work running now; an app
 * with none is left out. What landed is `clientFinished`'s. One query, at most
 * one row per app.
 */
export function clientDoings(
  db: Database,
  appIds: readonly string[],
): ReadonlyMap<string, ClientDoing> {
  const doings = new Map<string, ClientDoing>();
  if (appIds.length === 0) return doings;
  const rows = db
    .query<{ repo_id: string; title: string }, string[]>(
      `SELECT repo_id, title FROM (
         SELECT r.repo_id AS repo_id, i.title AS title,
                ROW_NUMBER() OVER (
                  PARTITION BY r.repo_id ORDER BY COALESCE(r.started_at, r.created_at) DESC
                ) AS n
         FROM run r JOIN issue i ON i.id = r.issue_id
         WHERE r.kind = 'agent' AND r.state = 'running'
           AND r.repo_id IN (${appIds.map((_, i) => `?${i + 1}`).join(",")})
       ) WHERE n = 1`,
    )
    .all(...appIds);
  for (const row of rows) doings.set(row.repo_id, { title: row.title });
  return doings;
}

/** What one app last had finished: the title of its newest merged pull and when. */
export interface ClientFinished {
  readonly title: string;
  readonly at: string;
}

/**
 * For each of `appIds` (repo ids), its most recently merged pull, however old;
 * an app with none is left out. One query, at most one row per app.
 */
export function clientFinished(
  db: Database,
  appIds: readonly string[],
): ReadonlyMap<string, ClientFinished> {
  const finished = new Map<string, ClientFinished>();
  if (appIds.length === 0) return finished;
  const rows = db
    .query<{ repo_id: string; title: string; at: string }, string[]>(
      `SELECT repo_id, title, at FROM (
         SELECT i.repo_id AS repo_id, i.title AS title, p.merged_at AS at,
                ROW_NUMBER() OVER (PARTITION BY i.repo_id ORDER BY p.merged_at DESC) AS n
         FROM issue i JOIN pull p ON p.issue_id = i.id
         WHERE i.kind = 'pull' AND p.merged_at IS NOT NULL
           AND i.repo_id IN (${appIds.map((_, i) => `?${i + 1}`).join(",")})
       ) WHERE n = 1`,
    )
    .all(...appIds);
  for (const row of rows) finished.set(row.repo_id, { title: row.title, at: row.at });
  return finished;
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

/** The sentence about what an app's agents are on, or "" when none is running. */
export function doingLine(doing: ClientDoing | undefined): string {
  const title = doing === undefined ? "" : cutTitle(doing.title);
  return title === "" ? "" : `Working on: ${title}`;
}

/** `Finished 3 days ago: Fix the menu`, or "" for an app with nothing finished; both doors word it so. */
export function finishedLine(finished: ClientFinished | undefined, now: number): string {
  const title = finished === undefined ? "" : cutTitle(finished.title);
  if (finished === undefined || title === "") return "";
  const at = Date.parse(finished.at);
  return Number.isNaN(at) ? "" : `Finished ${ago(at, now)}: ${title}`;
}
