/**
 * Every repository's flows in one list (#9594), for a site admin: one line
 * per followed upstream, followed source, fork family, mirror and scan, with
 * its state and when it last moved. A handful of set-based reads of state the
 * forge already keeps (no per-repository query, no network, no model), so it
 * answers in milliseconds for hundreds of repositories. Doors: the page
 * `web/pages/flows-all.ts` and the terminal screen `tui/screens/flowsall.ts`;
 * how to use it: docs/features/admin-flows.md.
 */

import type { Database } from "bun:sqlite";
import { followHealth, plainUrl, type Health } from "./view.ts";

/** A scan is stale when its last run is older than this: three days, since scans run on pushes and nightly, not every follow period. */
export const SCAN_STALE_MS = 3 * 24 * 60 * 60_000;

export const ALL_KINDS = ["upstream", "source", "fork", "mirror", "scan"] as const;
export type AllKind = (typeof ALL_KINDS)[number];

export interface AllLine {
  readonly repo: string;
  readonly href: string;
  readonly kind: AllKind;
  readonly label: string;
  readonly state: string;
  readonly at: string | null;
  readonly health: Health;
  /** Not read lately: a followed link past STALE_MS, or one never read. */
  readonly stale: boolean;
}

export interface AllFilter {
  readonly kind?: AllKind;
  readonly stale?: boolean;
}

/** A query value as a kind, or undefined when it is not one. */
export const parseKind = (raw: string | null | undefined): AllKind | undefined => ALL_KINDS.find((k) => k === raw);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

interface Followed { repo_id: string; url: string; branch: string; enabled: number; checked_at: string | null; behind: number; error: string }

export function readAllFlows(db: Database, filter: AllFilter = {}, now = Date.now()): AllLine[] {
  const repos = new Map<string, { name: string; href: string }>();
  for (const r of db
    .query<{ id: string; name: string; owner: string }, []>("SELECT repo.id, repo.name, user.username AS owner FROM repo JOIN user ON user.id = repo.owner_id")
    .all())
    repos.set(r.id, { name: `${r.owner}/${r.name}`, href: `/${r.owner}/${r.name}` });
  const lines: AllLine[] = [];
  const add = (repoId: string, l: Omit<AllLine, "repo" | "href" | "stale">) => {
    const r = repos.get(repoId);
    if (!r) return;
    lines.push({ repo: r.name, href: `${r.href}/flows`, ...l, stale: l.health === "stale" });
  };
  const followed = (kind: "upstream" | "source", table: string) => {
    for (const s of db.query<Followed, []>(`SELECT repo_id, url, branch, enabled, checked_at, behind, error FROM ${table}`).all()) {
      const health = followHealth({ enabled: s.enabled !== 0, checkedAt: s.checked_at, behind: s.behind, error: s.error }, now);
      add(s.repo_id, {
        kind, label: `${plainUrl(s.url)} (${s.branch})`, at: s.checked_at, health,
        state: s.enabled === 0 ? "not following" : s.error !== "" ? "could not be read" : s.behind === 0 ? "up to date" : plural(s.behind, "change", "changes") + " behind",
      });
    }
  };
  followed("upstream", "repo_upstream");
  followed("source", "repo_source");
  for (const f of db
    .query<{ parent: string; n: number; at: string | null }, []>(
      "SELECT fork_parent_id AS parent, count(*) AS n, max(created_at) AS at FROM repo WHERE fork_parent_id IS NOT NULL GROUP BY fork_parent_id",
    )
    .all())
    add(f.parent, { kind: "fork", label: "forks", state: plural(f.n, "fork", "forks"), at: f.at, health: "none" });
  for (const m of db
    .query<{ repo_id: string; full_name: string; pushed_at: string | null; last_error: string }, []>("SELECT repo_id, full_name, pushed_at, last_error FROM migrate_mirror")
    .all())
    add(m.repo_id, {
      kind: "mirror", label: m.full_name, at: m.pushed_at,
      state: m.last_error !== "" ? "last push failed" : "mirrored", health: m.last_error !== "" ? "unread" : "ok",
    });
  const high = new Map<string, number>();
  for (const h of db
    .query<{ repo_id: string; n: number }, []>("SELECT repo_id, count(*) AS n FROM scan_finding WHERE accepted_at IS NULL AND severity = 'high' GROUP BY repo_id")
    .all())
    high.set(h.repo_id, h.n);
  for (const s of db.query<{ repo_id: string; at: string }, []>("SELECT repo_id, max(at) AS at FROM scan_run GROUP BY repo_id").all()) {
    const n = high.get(s.repo_id) ?? 0;
    add(s.repo_id, {
      kind: "scan", label: "Code scanning", at: s.at,
      state: n > 0 ? `${plural(n, "high finding holds", "high findings hold")} releases` : "no open high findings",
      health: n > 0 ? "unread" : Date.parse(s.at) < now - SCAN_STALE_MS ? "stale" : "ok",
    });
  }
  const kept = lines.filter((l) => (filter.kind === undefined || l.kind === filter.kind) && (filter.stale !== true || l.stale));
  // Newest movement first; never-moved last.
  return kept.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.repo.localeCompare(b.repo));
}
