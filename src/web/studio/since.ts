/**
 * "Since you were here · 2 days": the pulls that landed in public repositories
 * since the viewer last loaded home (`core/home_visit.ts`), as the digest's
 * lines. Nothing landed, no section. Private repositories are never read here.
 */

import type { Database } from "bun:sqlite";
import { digest, headingOf, windowOf, type DigestEvent, type DigestLine } from "../../feed/digest.ts";
import { html, type Html } from "../html.ts";
import { listCard, row } from "../ui.ts";

interface Row {
  owner: string;
  name: string;
  number: number;
  merged_at: string;
}

export function landedSince(db: Database, since: number, now: number): DigestEvent[] {
  const rows = db
    .query<Row, [string, string]>(
      `SELECT u.username AS owner, r.name AS name, i.number AS number, p.merged_at AS merged_at
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = r.owner_id
        WHERE p.merged_at >= ?1 AND p.merged_at <= ?2 AND r.visibility = 'public'
        ORDER BY p.merged_at DESC LIMIT 200`,
    )
    .all(new Date(since).toISOString(), new Date(now).toISOString());
  return rows.map((r) => ({
    repo: `${r.owner}/${r.name}`,
    kind: "landed",
    at: Date.parse(r.merged_at),
    href: `/${r.owner}/${r.name}/pulls/${r.number}`,
    weight: 1,
  }));
}

/** The heading and lines of the digest since `lastVisit`; no lines, no digest. */
export function sinceDigest(
  db: Database,
  lastVisit: number | undefined,
  now: number,
): { heading: string; lines: DigestLine[] } | undefined {
  const window = windowOf(lastVisit, now);
  const lines = digest(landedSince(db, now - window, now), now, window);
  return lines.length === 0 ? undefined : { heading: headingOf(window), lines };
}

export function sinceYouWere(db: Database, lastVisit: number | undefined, now: number): Html {
  const d = sinceDigest(db, lastVisit, now);
  if (d === undefined) return html``;
  return listCard(
    d.lines.map((l) => row({ title: html`${l.says}`, href: l.href, nav: true })),
    { id: "since-you-were-here", head: html`<h2>${d.heading}</h2>` },
  );
}
