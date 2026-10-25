/**
 * A repository following an outside upstream (#3442): the git URL and
 * branch new commits come from, whether it is on, who the forge acts as
 * when it proposes them, and what the last check read. The commits
 * themselves are git's (`refs/upstream-follow/<branch>` in the repository); this
 * row is the setting and the last reading, rebuilt by the next check.
 *
 * Pure data, no authz, no events.
 */

import type { Database } from "bun:sqlite";

export interface UpstreamFollow {
  readonly repoId: string;
  /** A git URL git may be handed (`migrateUrl`). */
  readonly url: string;
  readonly branch: string;
  readonly enabled: boolean;
  /** The person the forge acts as: who turned it on. */
  readonly byId: string;
  /** The connected origin whose credential opens a private upstream; "" for none. */
  readonly originId: string;
  /** The upstream's own parent, when its host said it is a fork: the second choice. */
  readonly parentUrl: string;
  readonly checkedAt: string | null;
  /** The upstream tip the last check read; "" before the first. */
  readonly tip: string;
  /** Commits on the upstream branch the default branch does not hold. */
  readonly behind: number;
  /** Why the last check could not finish; "" when it did. */
  readonly error: string;
  /** The pull or issue carrying the last proposal, while it is open. */
  readonly pendingId: string | null;
  /** How many proposals the forge has opened for this repository. */
  readonly opened: number;
  /** When a check took the claim, or null when none is running. */
  readonly checking: string | null;
}

/**
 * An address a follow may hold: `https:` or `http:` only, no credentials.
 * `git:` resolves the name itself, past the pin; `ssh:`, `file:` and the
 * rest are not fetches the forge makes for a stranger. Returns the
 * normalised URL, or `undefined`.
 */
export function upstreamUrl(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (parsed.hostname === "" || parsed.username !== "" || parsed.password !== "")
    return undefined;
  return parsed.toString();
}

interface Row {
  repo_id: string;
  url: string;
  branch: string;
  enabled: number;
  by_id: string;
  origin_id: string;
  parent_url: string;
  checked_at: string | null;
  tip: string;
  behind: number;
  error: string;
  pending_id: string | null;
  opened: number;
  checking: string | null;
}

const fromRow = (r: Row): UpstreamFollow => ({
  repoId: r.repo_id,
  url: r.url,
  branch: r.branch,
  enabled: r.enabled === 1,
  byId: r.by_id,
  originId: r.origin_id,
  parentUrl: r.parent_url,
  checkedAt: r.checked_at,
  tip: r.tip,
  behind: r.behind,
  error: r.error,
  pendingId: r.pending_id,
  opened: r.opened,
  checking: r.checking,
});

export function getFollow(db: Database, repoId: string): UpstreamFollow | undefined {
  const row = db
    .query<Row, [string]>("SELECT * FROM repo_upstream WHERE repo_id = ?1")
    .get(repoId);
  return row ? fromRow(row) : undefined;
}

/** Every repository whose following is on. */
export function listFollowing(db: Database): UpstreamFollow[] {
  return db
    .query<Row, []>("SELECT * FROM repo_upstream WHERE enabled = 1 ORDER BY repo_id")
    .all()
    .map(fromRow);
}

/**
 * Set where a repository follows and whether it does. A new URL or branch
 * forgets the last reading — it was of another upstream.
 */
export function putFollow(
  db: Database,
  input: {
    readonly repoId: string;
    readonly url: string;
    readonly branch: string;
    readonly enabled: boolean;
    readonly byId: string;
    readonly originId: string;
    readonly parentUrl?: string;
  },
): UpstreamFollow {
  if (upstreamUrl(input.url) === undefined)
    throw new Error("an upstream is an https or http address with no credentials");
  const now = new Date().toISOString();
  const was = getFollow(db, input.repoId);
  const moved = was !== undefined && (was.url !== input.url || was.branch !== input.branch);
  db.query(
    `INSERT INTO repo_upstream (repo_id, url, branch, enabled, by_id, origin_id, parent_url, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(repo_id) DO UPDATE SET url = ?2, branch = ?3, enabled = ?4,
       by_id = ?5, origin_id = ?6, parent_url = CASE WHEN ?7 = '' THEN parent_url ELSE ?7 END,
       updated_at = ?8`,
  ).run(
    input.repoId,
    input.url,
    input.branch,
    input.enabled ? 1 : 0,
    input.byId,
    input.originId,
    input.parentUrl ?? "",
    now,
  );
  if (moved) {
    db.query("DELETE FROM repo_upstream_check WHERE repo_id = ?1").run(input.repoId);
    db.query(
      "UPDATE repo_upstream SET checked_at = NULL, tip = '', behind = 0, error = '' WHERE repo_id = ?1",
    ).run(input.repoId);
  }
  return getFollow(db, input.repoId)!;
}

/** What one check read. `pendingId` is left alone when absent. */
export function noteCheck(
  db: Database,
  repoId: string,
  reading: {
    readonly at: string;
    readonly tip?: string;
    readonly behind?: number;
    readonly error: string;
    readonly pendingId?: string | null;
    /** A proposal was opened by this check. */
    readonly opened?: boolean;
    /** How many files conflict, when the error is "conflict". */
    readonly files?: number;
  },
): void {
  db.query(
    `UPDATE repo_upstream SET checked_at = ?2,
       tip = COALESCE(?3, tip), behind = COALESCE(?4, behind), error = ?5,
       pending_id = CASE WHEN ?6 = 1 THEN ?7 ELSE pending_id END,
       opened = opened + ?8
     WHERE repo_id = ?1`,
  ).run(
    repoId,
    reading.at,
    reading.tip ?? null,
    reading.behind ?? null,
    reading.error,
    reading.pendingId === undefined ? 0 : 1,
    reading.pendingId ?? null,
    reading.opened === true ? 1 : 0,
  );
  recordCheck(db, repoId, reading);
}

/** How many checks are kept per repository. */
export const HISTORY_KEPT = 20;

export interface FollowCheck {
  readonly at: string;
  readonly behind: number;
  readonly outcome: "merged" | "uptodate" | "conflict" | "error";
  /** The conflict's file count, or the error's first line; "" otherwise. */
  readonly detail: string;
}

function recordCheck(
  db: Database,
  repoId: string,
  r: { readonly at: string; readonly behind?: number; readonly error: string; readonly files?: number },
): void {
  const outcome =
    r.error === "conflict" ? "conflict" : r.error !== "" ? "error" : (r.behind ?? 0) === 0 ? "uptodate" : "merged";
  const detail =
    outcome === "conflict"
      ? String(r.files ?? 0)
      : outcome === "error"
        ? (r.error.split("\n").find((l) => l.trim() !== "") ?? "").slice(0, 200)
        : "";
  // A failed check read no count: it carries the last one the row holds.
  db.query(
    `INSERT INTO repo_upstream_check (repo_id, at, behind, outcome, detail)
     VALUES (?1, ?2, COALESCE(?3, (SELECT behind FROM repo_upstream WHERE repo_id = ?1), 0), ?4, ?5)`,
  ).run(repoId, r.at, r.behind ?? null, outcome, detail);
  db.query(
    `DELETE FROM repo_upstream_check WHERE repo_id = ?1 AND id NOT IN
       (SELECT id FROM repo_upstream_check WHERE repo_id = ?1 ORDER BY id DESC LIMIT ?2)`,
  ).run(repoId, HISTORY_KEPT);
}

/** The latest checks of a repository, newest first. */
export function listChecks(db: Database, repoId: string, limit = 5): FollowCheck[] {
  return db
    .query<FollowCheck, [string, number]>(
      "SELECT at, behind, outcome, detail FROM repo_upstream_check WHERE repo_id = ?1 ORDER BY id DESC LIMIT ?2",
    )
    .all(repoId, limit);
}
