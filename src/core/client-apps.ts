/**
 * A client's apps and how busy their agents are (#1812): one row per app on
 * the forge made for them, with the agent runs going and the ones lined up.
 * The web home and the terminal both read it, so they cannot disagree.
 */

import type { App } from "../app.ts";
import { spawnedRepos } from "./next-steps.ts";
import type { Repo } from "./repos.ts";
import type { User } from "./users.ts";

export interface ClientApp {
  readonly repo: Repo;
  /** Agent runs going now. */
  readonly working: number;
  /** Agent runs lined up, none going yet. */
  readonly queued: number;
}

/** The apps `user` can see on a spawned forge, each with its agent counts. */
export async function clientAppRows(
  app: App,
  user: User,
): Promise<readonly ClientApp[]> {
  const repos = await spawnedRepos(app, user);
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
