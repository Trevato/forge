/**
 * What is already settled: a post about a pull or an issue says so once its
 * subject merged, closed or was parked. One query reads a whole page.
 */

import type { Database } from "bun:sqlite";

export type Settled = "merged" | "closed" | "parked";

/** The kinds of post whose link is a pull or an issue. */
const ABOUT = new Set(["pull", "tell", "reply"]);
const SUBJECT = /^\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/(\d{1,9})$/;

interface Row {
  owner: string;
  repo: string;
  number: number;
  state: "open" | "closed";
  parked: number;
  merged_at: string | null;
}

/** Each post's settled state, by id; an open subject, or another kind of post, has none. */
export function settledOf(
  db: Database,
  posts: readonly { readonly id: string; readonly kind: string; readonly link: string }[],
): Map<string, Settled> {
  const out = new Map<string, Settled>();
  const wanted = new Map<string, string[]>();
  for (const p of posts) {
    const m = ABOUT.has(p.kind) ? SUBJECT.exec(p.link) : null;
    if (m === null) continue;
    const key = `${m[1]}/${m[2]}/${m[3]}`;
    wanted.set(key, [...(wanted.get(key) ?? []), p.id]);
  }
  if (wanted.size === 0) return out;
  const keys = [...wanted.keys()].map((k) => k.split("/") as [string, string, string]);
  const rows = db
    .query<Row, (string | number)[]>(
      `SELECT user.username AS owner, repo.name AS repo, issue.number, issue.state,
              issue.parked, pull.merged_at
       FROM issue JOIN repo ON repo.id = issue.repo_id JOIN user ON user.id = repo.owner_id
       LEFT JOIN pull ON pull.issue_id = issue.id
       WHERE (user.username, repo.name, issue.number) IN (VALUES ${keys
         .map((_, i) => `(?${3 * i + 1}, ?${3 * i + 2}, ?${3 * i + 3})`)
         .join(",")})`,
    )
    .all(...keys.flatMap(([o, r, n]) => [o, r, Number(n)]));
  for (const row of rows) {
    const state: Settled | undefined =
      row.merged_at !== null
        ? "merged"
        : row.state === "closed"
          ? row.parked === 1
            ? "parked"
            : "closed"
          : undefined;
    if (state === undefined) continue;
    for (const id of wanted.get(`${row.owner}/${row.repo}/${row.number}`) ?? [])
      out.set(id, state);
  }
  return out;
}
