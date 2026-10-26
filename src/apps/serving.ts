/**
 * What an app's host is serving: read from the forge's own deploy record,
 * never from git. Production names the newest release and the three before
 * it; a preview names the commit it last served. Plain data in, plain data out.
 */

import type { Database } from "bun:sqlite";

export type Served = { sha: string; at: string };

export type Serving =
  | { kind: "production"; releases: Served[] }
  | { kind: "preview"; pull: number; current?: Served };

/** The newest release and the three before it. */
export const SHOWN = 4;

/** Each commit once, at its latest deploy: a redeploy is not another release. */
function deploys(db: Database, repoId: string, env: string, limit: number): Served[] {
  return db
    .query<Served, [string, string, number]>(
      `SELECT commit_oid AS sha, MAX(serving_at) AS at FROM run
        WHERE repo_id = ?1 AND kind = 'deploy' AND env = ?2
          AND serving_at IS NOT NULL AND commit_oid <> ''
        GROUP BY commit_oid
        ORDER BY at DESC, MAX(id) DESC LIMIT ?3`,
    )
    .all(repoId, env, limit);
}

export function readServing(db: Database, repoId: string, env: string): Serving | undefined {
  if (env === "production")
    return { kind: "production", releases: deploys(db, repoId, env, SHOWN) };
  const pull = /^pull-(\d+)$/.exec(env)?.[1];
  if (pull === undefined) return undefined;
  const current = deploys(db, repoId, env, 1)[0];
  return { kind: "preview", pull: Number(pull), ...(current === undefined ? {} : { current }) };
}
