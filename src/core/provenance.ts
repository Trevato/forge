/**
 * Provenance: where a migrated repository came from, kept as data and
 * never as a connection (#3293). The source's address, and the chain it
 * forks when its host said so — `owner/name` on that same host, nearest
 * first. Nothing here reaches the source again; these are links for a
 * person to follow, and `shown` is the owner's switch for them.
 *
 * Pure data, no authz, no events: `actions/provenance.ts` decides who may
 * turn it off, and `web/chrome.ts` draws it.
 */

import type { Database } from "bun:sqlite";

export interface Provenance {
  readonly repoId: string;
  /** The source's web address: http(s), no credential, no `.git`. */
  readonly sourceUrl: string;
  /** `owner/name` of what the source forks, then what that forks; on the source's host. */
  readonly parents: readonly string[];
  /** "Show where this came from": off hides the line, the record stays. */
  readonly shown: boolean;
  readonly migratedAt: string;
}

/** The longest chain kept: a parent and its root is what the hosts report. */
export const MAX_PARENTS = 4;

const FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** `owner/name` as a host names a repository, and nothing that could be a path trick. */
export function isFullName(value: string): boolean {
  return FULL_NAME.test(value) && !value.split("/").some((s) => /^\.+$/.test(s));
}

/**
 * A source address fit to keep and to link: http or https, a host, no
 * user or password, no query or fragment, `.git` and trailing slashes
 * dropped — or `undefined`. Read rows pass through it again, so a value
 * the backfill took from an old event is held to the same rule.
 */
export function provenanceUrl(raw: string): string | undefined {
  const parsed = URL.parse(raw.trim());
  if (parsed === null) return undefined;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return undefined;
  if (parsed.hostname === "" || parsed.username !== "" || parsed.password !== "")
    return undefined;
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (path === "") return undefined;
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** What the line says for the source: `github.com/Trevato/SO-ARM100`. */
export function sourceLabel(sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  return `${parsed.host}${parsed.pathname}`;
}

/** A parent's page, on the source's host: `https://github.com/TheRobotStudio/SO-ARM100`. */
export function parentUrl(sourceUrl: string, parent: string): string {
  return `${new URL(sourceUrl).origin}/${parent}`;
}

/** The chain as kept: valid names only, no repeats, the source itself left out, capped. */
export function cleanParents(
  parents: readonly (string | null | undefined)[],
  self = "",
): string[] {
  const out: string[] = [];
  for (const p of parents) {
    if (p == null || !isFullName(p)) continue;
    if (p.toLowerCase() === self.toLowerCase()) continue;
    if (out.some((o) => o.toLowerCase() === p.toLowerCase())) continue;
    out.push(p);
    if (out.length === MAX_PARENTS) break;
  }
  return out;
}

/**
 * The trail a viewer is shown (#3293), resolved once for every door — the
 * header, the API, MCP and the terminal's About card. A repository's own
 * record decides first: shown, it is the trail; hidden, there is none, and
 * a parent's does not stand in for it. Without a record, a fork made here
 * inherits its parent's trail, only while that one is shown. `parent` is
 * the fork parent the viewer may read (`forkParentFor`), never the raw id.
 */
export function shownTrail(
  db: Database,
  repo: { readonly id: string },
  parent: { readonly id: string } | undefined,
): Provenance | undefined {
  const trail =
    getProvenance(db, repo.id) ??
    (parent === undefined ? undefined : getProvenance(db, parent.id));
  return trail?.shown === true ? trail : undefined;
}

/**
 * The trail as the API and MCP give it out: the source and the chain it
 * forks, each with its address — or `null` when `shownTrail` has none.
 */
export function provenanceFacts(
  db: Database,
  repo: { readonly id: string },
  parent: { readonly id: string } | undefined,
) {
  const trail = shownTrail(db, repo, parent);
  return trail === undefined ? null : trailFacts(trail);
}

/** One record in the shape `provenanceFacts` gives out, shown or not. */
export function trailFacts(trail: Provenance) {
  return {
    sourceUrl: trail.sourceUrl,
    source: sourceLabel(trail.sourceUrl),
    parents: trail.parents.map((fullName) => ({
      fullName,
      url: parentUrl(trail.sourceUrl, fullName),
    })),
    migratedAt: trail.migratedAt,
  };
}

interface Row {
  repo_id: string;
  source_url: string;
  parents: string;
  shown: number;
  migrated_at: string;
}

function parseParents(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value)
      ? cleanParents(value.filter((v): v is string => typeof v === "string"))
      : [];
  } catch {
    return [];
  }
}

/** The record, or `undefined` for a repository that was not migrated (or whose record is unusable). */
export function getProvenance(
  db: Database,
  repoId: string,
): Provenance | undefined {
  const row = db
    .query<Row, [string]>(
      "SELECT repo_id, source_url, parents, shown, migrated_at FROM repo_provenance WHERE repo_id = ?1",
    )
    .get(repoId);
  if (row === null) return undefined;
  const sourceUrl = provenanceUrl(row.source_url);
  if (sourceUrl === undefined) return undefined;
  return {
    repoId: row.repo_id,
    sourceUrl,
    parents: parseParents(row.parents),
    shown: row.shown !== 0,
    migratedAt: row.migrated_at,
  };
}

/**
 * Keep where a repository came from. A second record for the same
 * repository replaces the address and chain and leaves the owner's
 * switch as they set it: `shown` is written only when the record is new.
 * An address that is not fit to link keeps nothing.
 */
export function recordProvenance(
  db: Database,
  repoId: string,
  source: {
    readonly url: string;
    readonly parents: readonly string[];
    /** On a new record only. @default true */
    readonly shown?: boolean;
  },
  at = new Date().toISOString(),
): boolean {
  const url = provenanceUrl(source.url);
  if (url === undefined) return false;
  const self = new URL(url).pathname.slice(1);
  db.query(
    `INSERT INTO repo_provenance (repo_id, source_url, parents, migrated_at, shown)
       VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (repo_id) DO UPDATE SET source_url = excluded.source_url,
       parents = excluded.parents, migrated_at = excluded.migrated_at`,
  ).run(
    repoId,
    url,
    JSON.stringify(cleanParents(source.parents, self)),
    at,
    source.shown === false ? 0 : 1,
  );
  return true;
}

/** Turn the line on or off; `false` when there is no record to turn. */
export function setProvenanceShown(
  db: Database,
  repoId: string,
  shown: boolean,
): boolean {
  return (
    db
      .query("UPDATE repo_provenance SET shown = ?2 WHERE repo_id = ?1")
      .run(repoId, shown ? 1 : 0).changes > 0
  );
}
