/**
 * The sources a repository follows (#9003): any number, each an https or
 * http git address (a forge, or a fork on Forgejo) with its branch, read
 * anonymously or with a connected origin's credential. The commits are
 * git's (`refs/upstream-sources/<id>`); the row is the setting and the last
 * reading, rebuilt by the next check. The repository's one `upstream`
 * (`core/upstream_follow.ts`) stays as it was; these are in addition.
 *
 * Pure data, no authz, no events.
 */
import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { sourceOfUrl } from "./trusted_sources.ts";
import { upstreamUrl } from "./upstream_follow.ts";

export interface FollowSource {
  readonly id: string;
  readonly repoId: string;
  readonly url: string;
  readonly branch: string;
  readonly originId: string;
  /** The trusted account this source's work is stamped as; "" for the address's owner. */
  readonly account: string;
  readonly byId: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly checkedAt: string | null;
  readonly tip: string;
  readonly behind: number;
  readonly error: string;
  readonly pendingId: string | null;
  readonly opened: number;
}

interface Row {
  id: string;
  repo_id: string;
  url: string;
  branch: string;
  origin_id: string;
  account: string;
  by_id: string;
  enabled: number;
  created_at: string;
  checked_at: string | null;
  tip: string;
  behind: number;
  error: string;
  pending_id: string | null;
  opened: number;
}

const fromRow = (r: Row): FollowSource => ({
  id: r.id,
  repoId: r.repo_id,
  url: r.url,
  branch: r.branch,
  originId: r.origin_id,
  account: r.account,
  byId: r.by_id,
  enabled: r.enabled === 1,
  createdAt: r.created_at,
  checkedAt: r.checked_at,
  tip: r.tip,
  behind: r.behind,
  error: r.error,
  pendingId: r.pending_id,
  opened: r.opened,
});

/** Sources one repository may follow: a bound on the clock's work. */
export const SOURCES_PER_REPO = 20;

/** Where a staged source tip lives: not a branch, so a check moves nothing of ours. */
export const sourceRef = (sourceId: string): string => `refs/upstream-sources/${sourceId}`;

/** The branch a proposal for this source's tip is pushed to. */
export const sourceProposalBranch = (sourceId: string, tip: string): string =>
  `upstream/${sourceId.slice(-6).toLowerCase()}-${tip.slice(0, 7)}`;

export function addSource(
  db: Database,
  input: {
    readonly repoId: string;
    readonly url: string;
    readonly branch: string;
    readonly originId: string;
    readonly account: string;
    readonly byId: string;
  },
  now: Date = new Date(),
): FollowSource | "exists" | "too_many" {
  if (upstreamUrl(input.url) === undefined) throw new Error("a source is an https or http address with no credentials");
  const have = listSources(db, input.repoId);
  if (have.some((s) => s.url === input.url && s.branch === input.branch)) return "exists";
  if (have.length >= SOURCES_PER_REPO) return "too_many";
  const sourceId = id();
  db.query(
    `INSERT INTO repo_source (id, repo_id, url, branch, origin_id, account, by_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).run(sourceId, input.repoId, input.url, input.branch, input.originId, input.account, input.byId, now.toISOString());
  return getSource(db, sourceId)!;
}

export function getSource(db: Database, sourceId: string): FollowSource | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM repo_source WHERE id = ?1").get(sourceId);
  return row === null ? undefined : fromRow(row);
}

/** A repository's sources, oldest first. */
export function listSources(db: Database, repoId: string): FollowSource[] {
  return db
    .query<Row, [string]>("SELECT * FROM repo_source WHERE repo_id = ?1 ORDER BY created_at, id")
    .all(repoId)
    .map(fromRow);
}

/** Every source whose following is on. */
export function listActiveSources(db: Database): FollowSource[] {
  return db
    .query<Row, []>("SELECT * FROM repo_source WHERE enabled = 1 ORDER BY repo_id, created_at, id")
    .all()
    .map(fromRow);
}

export function removeSource(db: Database, sourceId: string): FollowSource | undefined {
  const was = getSource(db, sourceId);
  if (was === undefined) return undefined;
  db.query("DELETE FROM repo_source WHERE id = ?1").run(sourceId);
  return was;
}

/** What one check of a source read; `pendingId` is left alone when absent. */
export function noteSource(
  db: Database,
  sourceId: string,
  reading: {
    readonly at: string;
    readonly tip?: string;
    readonly behind?: number;
    readonly error: string;
    readonly pendingId?: string | null;
    readonly opened?: boolean;
  },
): void {
  db.query(
    `UPDATE repo_source SET checked_at = ?2, tip = COALESCE(?3, tip), behind = COALESCE(?4, behind),
       error = ?5, pending_id = CASE WHEN ?6 = 1 THEN ?7 ELSE pending_id END, opened = opened + ?8
     WHERE id = ?1`,
  ).run(
    sourceId,
    reading.at,
    reading.tip ?? null,
    reading.behind ?? null,
    reading.error,
    reading.pendingId === undefined ? 0 : 1,
    reading.pendingId ?? null,
    reading.opened === true ? 1 : 0,
  );
}

/** The forge and account a source's work is stamped as: the one a forge admin named, else the address's owner. */
export function stampOf(s: Pick<FollowSource, "url" | "account">): { host: string; account: string } | undefined {
  const named = sourceOfUrl(s.url);
  if (named === undefined) return undefined;
  return s.account === "" ? named : { host: named.host, account: s.account };
}

// --- a conflict issue remembers its source ---------------------------------

export interface ConflictOf {
  readonly sourceId: string;
  readonly host: string;
  readonly account: string;
  readonly via: readonly string[];
}

export function recordConflict(db: Database, issueId: string, c: ConflictOf): void {
  db.query(
    "INSERT OR IGNORE INTO source_conflict (issue_id, source_id, host, account, via) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).run(issueId, c.sourceId, c.host, c.account, c.via.join(","));
}

export function conflictOf(db: Database, issueId: string): ConflictOf | undefined {
  const r = db
    .query<{ source_id: string; host: string; account: string; via: string }, [string]>(
      "SELECT source_id, host, account, via FROM source_conflict WHERE issue_id = ?1",
    )
    .get(issueId);
  return r === null
    ? undefined
    : { sourceId: r.source_id, host: r.host, account: r.account, via: r.via === "" ? [] : r.via.split(",") };
}

/** Whether a source has a conflict issue still open: it waits for the crew rather than opening a second. */
export function openConflictOf(db: Database, sourceId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM source_conflict c JOIN issue i ON i.id = c.issue_id
          WHERE c.source_id = ?1 AND i.state = 'open'`,
      )
      .get(sourceId)!.n > 0
  );
}
