/**
 * Work from read-only origins, as its owner sees it on their profile (#10522):
 * every repository mirrored from an origin connected read-only, grouped by
 * origin, each with its last fetch and, when the last one failed, one plain
 * line saying why. Plain data out; the profile page draws it.
 */

import type { Database } from "bun:sqlite";
import type { ProviderFailure } from "./types.ts";

export interface WorkRepo {
  readonly name: string;
  readonly fullName: string;
  readonly lastFetchAt: string | null;
  /** One line, empty when the last fetch worked. */
  readonly problem: string;
}

export interface WorkOrigin {
  readonly originId: string;
  readonly webUrl: string;
  readonly repos: readonly WorkRepo[];
}

/** One line a person can act on, from what a provider said. */
export function failureWords(failure: Pick<ProviderFailure, "error">): string {
  switch (failure.error) {
    case "unauthorized":
    case "forbidden":
      return "the token was refused: reconnect the origin with a fresh one";
    case "not_found":
      return "the repository is gone or no longer visible to this token";
    case "unreachable":
      return "the host could not be reached";
    case "rate_limited":
      return "the host asked us to wait; the next fetch will try again";
    default:
      return "the host answered something unexpected";
  }
}

/** One line from git's own complaint, never its raw text or a stack. */
export function gitFailureWords(text: string): string {
  if (text.includes("unusable clone URL")) return "refusing an unusable clone URL";
  const t = text.toLowerCase();
  if (/\b(401|403)\b|authentication|denied|invalid credentials|bad credentials/.test(t))
    return failureWords({ error: "unauthorized" });
  if (/\b404\b|not found|does not exist|not appear to be a git repository/.test(t))
    return failureWords({ error: "not_found" });
  if (/could not resolve|unable to (access|connect)|timed out|refused|unreachable|network/.test(t))
    return failureWords({ error: "unreachable" });
  return "git could not fetch from the host";
}

interface Row {
  origin_id: string;
  web_url: string;
  name: string;
  origin_full_name: string;
  last_fetch_at: string | null;
  fetch_error: string;
}

/** The user's mirrors of read-only origins; nothing for anyone else's id. */
export function readOnlyWork(db: Database, userId: string): WorkOrigin[] {
  const rows = db
    .query<Row, [string]>(
      `SELECT o.id AS origin_id, o.web_url, r.name, r.origin_full_name, r.last_fetch_at, r.fetch_error
         FROM repo r JOIN origin o ON o.id = r.origin_id
        WHERE o.user_id = ?1 AND r.owner_id = ?1 AND o.read_only = 1 AND r.origin_full_name IS NOT NULL
        ORDER BY o.id, r.name COLLATE NOCASE`,
    )
    .all(userId);
  const out = new Map<string, { webUrl: string; repos: WorkRepo[] }>();
  for (const r of rows) {
    const group = out.get(r.origin_id) ?? { webUrl: r.web_url, repos: [] };
    group.repos.push({
      name: r.name,
      fullName: r.origin_full_name,
      lastFetchAt: r.last_fetch_at,
      problem: r.fetch_error,
    });
    out.set(r.origin_id, group);
  }
  return [...out].map(([originId, g]) => ({ originId, ...g }));
}
