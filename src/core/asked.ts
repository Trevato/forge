/**
 * What people asked for, and what became of it.
 *
 * An ask is an issue a person opened — never one an agent filed, never one
 * imported from an origin under someone else's name. Each comes back with
 * its age, the pulls that say they close it, and one state word read from
 * those facts: `shipped` once one of them merged, `building` while one is
 * open or the crew is running on it, `closed` when it closed with nothing
 * merged, `waiting` otherwise. An ask that is not shipped or closed and is
 * older than the stale window is `flagged`: nothing was built for it.
 *
 * Every row is derived on read from the issue, pull and run tables, so
 * nothing here can drift from the map. `source` names where the ask came
 * from, so the thought stream can join this list as a second source with
 * the same row shape.
 */

import type { Database } from "bun:sqlite";
import { getIssuesByIds, type Issue } from "./issues.ts";
import { closesFromBody } from "./pulls.ts";
import { getRepo, listReposWritableTo, type Repo } from "./repos.ts";
import { listActiveRuns } from "./runs.ts";
import type { User } from "./users.ts";

export type AskedState = "waiting" | "building" | "shipped" | "closed";

export interface AskedPull {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
}

export interface Asked {
  readonly source: "issue";
  readonly repo: Repo;
  readonly issue: Issue;
  /** Who asked: the issue's author. */
  readonly askedBy: string;
  readonly askedAt: string;
  readonly pulls: readonly AskedPull[];
  readonly state: AskedState;
  /** Not shipped or closed, and older than the stale window. */
  readonly flagged: boolean;
}

export type AskedShow = "all" | "unshipped" | "flagged";

export const isAskedShow = (value: unknown): value is AskedShow =>
  value === "all" || value === "unshipped" || value === "flagged";

/** How long an ask may wait with nothing built before it is flagged. */
export const STALE_DAYS = 3;

/** The most rows one read returns. */
export const ASKED_LIMIT = 200;

const DAY = 24 * 60 * 60 * 1000;

/** The newest asks read before filtering: a bound on one page's work. */
const SCAN_LIMIT = 2000;

interface AskRow {
  id: string;
}

interface PullRow {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged_at: string | null;
}

const placeholders = (n: number, from = 1): string =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");

/**
 * The repositories a viewer may read asks about: those they can write,
 * narrowed to one when `repoSpec` (`owner/name`) names one of them. Any
 * other name narrows to nothing, so a repository the viewer cannot write is
 * indistinguishable from one that does not exist.
 */
export function askedRepos(
  db: Database,
  viewer: User | undefined,
  repoSpec: string | null | undefined,
): readonly Repo[] {
  const writable = listReposWritableTo(db, viewer, { limit: 200 });
  if (repoSpec === null || repoSpec === undefined || repoSpec === "")
    return writable;
  const [owner, name, ...rest] = repoSpec.split("/");
  const one =
    owner && name && rest.length === 0 ? getRepo(db, owner, name) : undefined;
  return one !== undefined && writable.some((r) => r.id === one.id)
    ? [one]
    : [];
}

/**
 * The asks in these repositories, newest first. The caller decides which
 * repositories the viewer may read this about (writers of each).
 */
export function askedIn(
  db: Database,
  repos: readonly Repo[],
  options: { show?: AskedShow; now?: Date; limit?: number } = {},
): Asked[] {
  if (repos.length === 0) return [];
  const show = options.show ?? "all";
  const now = (options.now ?? new Date()).getTime();
  const limit = Math.min(
    Math.max(options.limit ?? ASKED_LIMIT, 1),
    ASKED_LIMIT,
  );
  const byId = new Map(repos.map((r) => [r.id, r]));
  const repoIds = [...byId.keys()];
  const direction = repos.flatMap((r) =>
    r.directionIssueId === null ? [] : [r.directionIssueId],
  );

  // A person's issues: the author is not an agent and the row is native.
  const ids = db
    .query<AskRow, string[]>(
      `SELECT issue.id FROM issue JOIN user ON user.id = issue.author_id
       WHERE issue.repo_id IN (${placeholders(repoIds.length)})
         AND issue.kind = 'issue' AND user.is_agent = 0
         AND issue.origin_author IS NULL
       ORDER BY issue.created_at DESC, issue.number DESC
       LIMIT ${SCAN_LIMIT}`,
    )
    .all(...repoIds)
    .map((r) => r.id)
    .filter((id) => !direction.includes(id));

  const pulls = new Map<string, AskedPull[]>();
  const rows = db
    .query<PullRow & { repo_id: string }, string[]>(
      `SELECT issue.repo_id, issue.number, issue.title, issue.body, issue.state,
              pull.merged_at
       FROM issue JOIN pull ON pull.issue_id = issue.id
       WHERE issue.repo_id IN (${placeholders(repoIds.length)})
       ORDER BY issue.number`,
    )
    .all(...repoIds);
  for (const row of rows)
    for (const n of closesFromBody(row.body)) {
      const key = `${row.repo_id}#${n}`;
      const list = pulls.get(key) ?? [];
      list.push({
        number: row.number,
        title: row.title,
        state:
          row.merged_at !== null
            ? "merged"
            : row.state === "open"
              ? "open"
              : "closed",
      });
      pulls.set(key, list);
    }

  const running = new Set(
    listActiveRuns(db, repoIds).flatMap((r) =>
      r.issueId === null ? [] : [r.issueId],
    ),
  );

  const out: Asked[] = [];
  for (const issue of getIssuesByIds(db, ids).values()) {
    const repo = byId.get(issue.repoId);
    if (repo === undefined) continue;
    const its = pulls.get(`${issue.repoId}#${issue.number}`) ?? [];
    const state: AskedState = its.some((p) => p.state === "merged")
      ? "shipped"
      : its.some((p) => p.state === "open") || running.has(issue.id)
        ? "building"
        : issue.state === "closed"
          ? "closed"
          : "waiting";
    const flagged =
      (state === "waiting" || state === "building") &&
      now - Date.parse(issue.createdAt) > STALE_DAYS * DAY;
    if (show === "unshipped" && (state === "shipped" || state === "closed"))
      continue;
    if (show === "flagged" && !flagged) continue;
    out.push({
      source: "issue",
      repo,
      issue,
      askedBy: issue.authorName,
      askedAt: issue.createdAt,
      pulls: its,
      state,
      flagged,
    });
  }
  out.sort(
    (a, b) =>
      b.askedAt.localeCompare(a.askedAt) || b.issue.number - a.issue.number,
  );
  return out.slice(0, limit);
}

/** The row as JSON, for the API and the MCP. */
export function askedJson(a: Asked) {
  return {
    source: a.source,
    repo: `${a.repo.ownerName}/${a.repo.name}`,
    number: a.issue.number,
    title: a.issue.title,
    askedBy: a.askedBy,
    askedAt: a.askedAt,
    issueState: a.issue.state,
    state: a.state,
    flagged: a.flagged,
    pulls: a.pulls,
  };
}
