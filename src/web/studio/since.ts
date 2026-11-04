/**
 * "Since you were here · 2 days": the pulls that landed, the releases and the
 * red gates since the viewer last loaded home (`core/home_visit.ts`), as the
 * digest's lines. Only repositories the viewer can read (`canRead`, as the
 * feed does) count. Nothing happened, no section.
 */

import type { Database } from "bun:sqlite";
import { lastVisit as visitOf } from "../../core/home_visit.ts";
import { canRead, getRepoById, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { digest, headingOf, windowOf, type DigestEvent, type DigestLine } from "../../feed/digest.ts";
import { html, type Html } from "../html.ts";
import { listCard, row } from "../ui.ts";

interface Landed {
  repo_id: string;
  number: number;
  merged_at: string;
}
interface Released {
  repo_id: string;
  pull_number: number | null;
  created_at: string;
}
interface Red {
  repo_id: string;
  pulls: string;
  finished_at: string;
}

/** Repositories are read through `canRead`, the feed's own check, once each. */
function readable(db: Database, viewer: User | undefined): (repoId: string) => Repo | undefined {
  const seen = new Map<string, Repo | undefined>();
  return (id) => {
    if (!seen.has(id)) {
      const repo = getRepoById(db, id);
      seen.set(id, repo && canRead(db, repo, viewer) ? repo : undefined);
    }
    return seen.get(id);
  };
}

/** A page a person reads: the pull when one is known, else the repository's pulls; never an API URL. */
function pageOf(repo: Repo, pull: number | null | undefined): string {
  const base = `/${repo.ownerName}/${repo.name}/pulls`;
  return Number.isInteger(pull) && (pull as number) > 0 ? `${base}/${pull}` : base;
}

/** The first pull number in a gate's JSON list of them, if it has one. */
function firstPull(json: string): number | null {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) && typeof list[0] === "number" ? list[0] : null;
  } catch {
    return null;
  }
}

/** What happened in the window, in the repositories `viewer` may read: landed pulls, releases, red gates. */
export function eventsSince(db: Database, viewer: User | undefined, since: number, now: number): DigestEvent[] {
  const from = new Date(since).toISOString();
  const to = new Date(now).toISOString();
  const may = readable(db, viewer);
  const out: DigestEvent[] = [];
  for (const r of db
    .query<Landed, [string, string]>(
      `SELECT r.id AS repo_id, i.number AS number, p.merged_at AS merged_at
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
        WHERE p.merged_at >= ?1 AND p.merged_at <= ?2 ORDER BY p.merged_at DESC LIMIT 200`,
    )
    .all(from, to)) {
    const repo = may(r.repo_id);
    if (repo) out.push({ repo: `${repo.ownerName}/${repo.name}`, kind: "landed", at: Date.parse(r.merged_at), href: `/${repo.ownerName}/${repo.name}/pulls/${r.number}`, weight: 1 });
  }
  for (const r of db
    .query<Released, [string, string]>(
      `SELECT repo_id, pull_number, created_at FROM release WHERE ok = 1 AND created_at >= ?1 AND created_at <= ?2 ORDER BY created_at DESC LIMIT 50`,
    )
    .all(from, to)) {
    const repo = may(r.repo_id);
    if (repo) out.push({ repo: `${repo.ownerName}/${repo.name}`, kind: "released", at: Date.parse(r.created_at), href: pageOf(repo, r.pull_number), weight: 2 });
  }
  for (const r of db
    .query<Red, [string, string]>(
      `SELECT repo_id, pulls, finished_at FROM gate_result WHERE state = 'red' AND finished_at >= ?1 AND finished_at <= ?2 ORDER BY finished_at DESC LIMIT 50`,
    )
    .all(from, to)) {
    const repo = may(r.repo_id);
    if (repo)
      out.push({ repo: `${repo.ownerName}/${repo.name}`, kind: "failed", at: Date.parse(r.finished_at), href: pageOf(repo, firstPull(r.pulls)), weight: 3 });
  }
  return out;
}

/** The heading and lines of the digest since `lastVisit`; no lines, no digest. */
export function sinceDigest(
  db: Database,
  viewer: User | undefined,
  lastVisit: number | undefined,
  now: number,
): { heading: string; lines: DigestLine[] } | undefined {
  const window = windowOf(lastVisit, now);
  const lines = digest(eventsSince(db, viewer, now - window, now), now, window);
  return lines.length === 0 ? undefined : { heading: headingOf(window), lines };
}

/** The digest a feed's first page carries (HTTP and MCP alike): read-only, a visit is never noted; `null` when there is nothing. */
export function feedDigest(db: Database, viewer: User, now: number): { heading: string; lines: DigestLine[] } | null {
  return sinceDigest(db, viewer, visitOf(db, viewer.id), now) ?? null;
}

export function sinceYouWere(db: Database, viewer: User | undefined, lastVisit: number | undefined, now: number): Html {
  const d = sinceDigest(db, viewer, lastVisit, now);
  if (d === undefined) return html``;
  return listCard(
    d.lines.map((l) => row({ title: html`${l.says}`, href: l.href, nav: true })),
    { id: "since-you-were-here", head: html`<h2>${d.heading}</h2>` },
  );
}
