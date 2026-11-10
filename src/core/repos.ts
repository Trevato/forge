/**
 * Repositories: a row in the index and a bare repo on disk. Ordering
 * invariant, paid for elsewhere: the git directory becomes durable BEFORE
 * the row that references it, so a visible row always means a clonable
 * repo. Deletion inverts the order — row first, directory second.
 */

import { contributionForksSince, isContributionFork } from "./contribute.ts";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { isSafeName } from "../git/guard.ts";
import { installHooks } from "../git/hooks.ts";
import { closeReader } from "../git/read.ts";
import {
  deleteRepoDir,
  detachFork,
  forkBareRepo,
  initBareRepo,
  repoDirExists,
  repoDir,
} from "../git/repos.ts";
import { id } from "../kernel/id.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { appsNaming, isAppMember } from "./app_members.ts";
import { forgetListings } from "./listings.ts";
import { forgetRepoCursors } from "./origins.ts";
import { likeEscape, pageLimit } from "./issues.ts";
import {
  OWNER_STANDING,
  PUBLIC_VISIBLE,
  REPO_VISIBLE,
  REPO_WRITABLE,
} from "./visibility.ts";
import {
  accessAllows,
  orgAccess,
  orgAccessByOrg,
  type Access,
} from "./orgs.ts";
import { getUserById, isActive, type User } from "./users.ts";

const log = createLog("repos");

/**
 * Where a mirrored repo came from. Present only while the origin is still
 * connected: disconnecting sets `repo.origin_id` to NULL, and the repo goes
 * on being readable as an ordinary local one that simply stopped syncing.
 */
export interface RepoOrigin {
  readonly originId: string;
  readonly kind: "github" | "forgejo" | "gitea";
  /** `owner/name` on the origin. */
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly lastFetchAt: string | null;
  /** The last fetch's failure, or empty when healthy. */
  readonly fetchError: string;
}

/** What a detached mirror still knows of where it came from. */
export interface RepoDetached {
  /** `owner/name` on the origin it mirrored. */
  readonly fullName: string;
  /** The origin's page for it; may be empty. */
  readonly htmlUrl: string;
  /** When the origin went; null when that was never recorded. */
  readonly detachedAt: string | null;
  /** The last fetch that reached it: the moment it froze. */
  readonly frozenSince: string | null;
}

/**
 * What a repo list wants beside every row. Both numbers are open counts —
 * a closed conversation is history, not a queue.
 */
export interface RepoCounts {
  readonly openIssues: number;
  readonly openPulls: number;
}

export type Autonomy = "off" | "assisted" | "autonomous";
export const AUTONOMY: readonly Autonomy[] = ["off", "assisted", "autonomous"];
export const isAutonomy = (value: unknown): value is Autonomy =>
  (AUTONOMY as readonly unknown[]).includes(value);

/** What the settings page and the terminal say when autonomy input is out of bounds. */
export const AUTONOMY_BOUNDS =
  "Mode is off, assisted or autonomous; the ceiling is a number of dollars; slots are 0 (paused) to 8.";

/** What each mode does, in one sentence: the settings page's flash and the terminal's toast. */
export const AUTONOMY_SAID: Readonly<Record<Autonomy, string>> = {
  off: "Autonomy is off.",
  assisted: "Assisted: the crew works what is ready; green waits for you.",
  autonomous: "Autonomous: the crew works what is ready and ships on green, as you.",
};

/** The mode, dollar ceiling and slots, checked once for every surface; the sentence is the refusal. */
export function checkAutonomy(
  mode: unknown,
  ceiling: number,
  slots: number,
): { ok: true; mode: Autonomy } | { ok: false; message: string } {
  if (
    !isAutonomy(mode) ||
    !Number.isFinite(ceiling) ||
    ceiling < 0 ||
    !Number.isInteger(slots) ||
    slots < 0 ||
    slots > PILLAR_MAX
  )
    return { ok: false, message: AUTONOMY_BOUNDS };
  return { ok: true, mode };
}

/** The most any pillar may be set to at once. */
export const PILLAR_MAX = 8;

export interface Repo {
  readonly id: string;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly description: string;
  readonly defaultBranch: string;
  readonly protectDefault: boolean;
  /**
   * Whether a pull needs an approval of its current head before it merges.
   * Mechanical, not advisory: `mergePull` refuses `review_required`.
   */
  readonly requireReview: boolean;
  /**
   * Whether a pull's current head must have a passing deploy run before it
   * merges. Read live inside `mergePull`, like `requireReview`.
   */
  readonly requireChecks: boolean;
  /**
   * How much the crew does here on its own (docs/PLANNING.md): `off`, every
   * run starts because a person acted; `assisted`, the crew works what is
   * ready and green waits for a look; `autonomous`, green ships and an empty
   * map wakes the planner. `autonomyBy` is the person the forge acts as.
   */
  readonly autonomy: Autonomy;
  readonly autonomyDirection: string;
  readonly autonomyCeilingUsd: number;
  readonly autonomySlots: number;
  /** Planning passes at once: 0 pauses the planner, 1 is the most. */
  readonly plannerSlots: number;
  /** Reviews at once: 0 pauses the reviewer. */
  readonly reviewerSlots: number;
  /** Percent of a week's agent spend polish may take, 0 to 50 (#8853). */
  readonly polishShare: number;
  readonly autonomyBy: string | null;
  /**
   * "Outsiders may trigger the crew": whether someone who cannot write here
   * may still start or steer a run by speaking (`crew/direct.ts`). Off by
   * default; on a public repository it hands strangers the owner's budget.
   */
  readonly crewOutsiders: boolean;
  /** The standing rule for decisions here: `me`, `decider`, or `decider_tell`. */
  readonly decisionsBy: DecisionsBy;
  /** "Plans need a nod": a plan is stored as a proposal, not opened. */
  readonly plansNeedNod: boolean;
  /** The issue the planner is given, when the map has run dry. */
  readonly directionIssueId: string | null;
  /** The repo this was forked from, or null. */
  readonly forkParentId: string | null;
  /**
   * The repository whose sealed reports this one holds the work for
   * (`core/sealed.ts`): a private repository its owner's crew pushes to,
   * read only by the base's writers and crew. Null for every other one.
   */
  readonly sealedFor: string | null;
  /** When an admin archived it (ISO time), or null: put away, not deleted. */
  readonly archivedAt: string | null;
  /** The origin this mirrors, or null for a native repo. */
  readonly origin: RepoOrigin | null;
  /**
   * A mirror whose origin was disconnected: the provenance it kept, frozen
   * until an origin is attached again (#1090). Null for a native repo and
   * for a mirror that is still attached. Read off the same row as the rest,
   * so a list says which of its rows are frozen without a query per row.
   */
  readonly detached: RepoDetached | null;
  /**
   * Open issue and pull counts. Absent from a bare `getRepo` — a single
   * fetch on a hot path should not pay for a count nobody asked for — and
   * always present on a list, filled by `countsForRepos` in one query.
   */
  readonly counts?: RepoCounts;
}

interface RepoRow {
  id: string;
  owner_id: string;
  owner_name: string;
  name: string;
  visibility: "public" | "private";
  description: string;
  default_branch: string;
  protect_default: number;
  require_review: number;
  require_checks: number;
  autonomy: string;
  autonomy_direction: string;
  autonomy_ceiling_usd: number;
  autonomy_slots: number;
  planner_slots: number;
  reviewer_slots: number;
  polish_share: number;
  autonomy_by: string | null;
  crew_outsiders: number;
  decisions_by: string;
  plans_need_nod: number;
  direction_issue_id: string | null;
  fork_parent_id: string | null;
  sealed_for: string | null;
  archived_at: string | null;
  origin_id: string | null;
  origin_kind: "github" | "forgejo" | "gitea" | null;
  origin_full_name: string | null;
  origin_html_url: string | null;
  last_fetch_at: string | null;
  fetch_error: string;
  origin_detached_at: string | null;
}

// LEFT JOIN, because the origin may have been disconnected out from under a
// mirror — the repo survives, the link does not.
const SELECT = `
  SELECT repo.*, user.username AS owner_name, origin.kind AS origin_kind
  FROM repo JOIN user ON user.id = repo.owner_id
  LEFT JOIN origin ON origin.id = repo.origin_id`;

/** The by-name match `getRepo` and `repoVisibility` share, so the two cannot drift. */
const BY_NAME = "user.username = ?1 COLLATE NOCASE AND repo.name = ?2 COLLATE NOCASE";

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    name: row.name,
    visibility: row.visibility,
    description: row.description,
    defaultBranch: row.default_branch,
    protectDefault: row.protect_default === 1,
    requireReview: row.require_review === 1,
    requireChecks: row.require_checks === 1,
    autonomy: isAutonomy(row.autonomy) ? row.autonomy : "off",
    autonomyDirection: row.autonomy_direction,
    autonomyCeilingUsd: row.autonomy_ceiling_usd,
    autonomySlots: row.autonomy_slots,
    plannerSlots: row.planner_slots,
    reviewerSlots: row.reviewer_slots,
    polishShare: row.polish_share,
    autonomyBy: row.autonomy_by,
    crewOutsiders: row.crew_outsiders === 1,
    decisionsBy: isDecisionsBy(row.decisions_by) ? row.decisions_by : "me",
    plansNeedNod: row.plans_need_nod === 1,
    directionIssueId: row.direction_issue_id,
    forkParentId: row.fork_parent_id,
    sealedFor: row.sealed_for,
    archivedAt: row.archived_at,
    origin:
      row.origin_id !== null && row.origin_kind !== null
        ? {
            originId: row.origin_id,
            kind: row.origin_kind,
            fullName: row.origin_full_name ?? "",
            htmlUrl: row.origin_html_url ?? "",
            lastFetchAt: row.last_fetch_at,
            fetchError: row.fetch_error,
          }
        : null,
    detached:
      row.origin_id === null &&
      row.origin_full_name !== null &&
      row.origin_full_name !== ""
        ? {
            fullName: row.origin_full_name,
            htmlUrl: row.origin_html_url ?? "",
            detachedAt: row.origin_detached_at,
            frozenSince: row.last_fetch_at,
          }
        : null,
  };
}

const NO_COUNTS: RepoCounts = { openIssues: 0, openPulls: 0 };

/** How many ids one `IN (...)` carries; the rest come in further rounds. */
const COUNT_CHUNK = 500;

/**
 * Open issue and pull counts for many repos, in one grouped query per chunk
 * — never one query per row. A repo list is the place N+1 hurts most (the
 * dashboard asks for fifty repos at once), so the grouped shape is the only
 * shape offered: there is deliberately no `countsForRepo` singular.
 */
export function countsForRepos(
  db: Database,
  repoIds: readonly string[],
): Map<string, RepoCounts> {
  const counts = new Map<string, RepoCounts>();
  for (const id of repoIds) counts.set(id, NO_COUNTS);
  for (let i = 0; i < repoIds.length; i += COUNT_CHUNK) {
    const chunk = repoIds.slice(i, i + COUNT_CHUNK);
    if (chunk.length === 0) continue;
    const holes = chunk.map((_, n) => `?${n + 1}`).join(",");
    const rows = db
      .query<{ repo_id: string; kind: "issue" | "pull"; n: number }, string[]>(
        // A sealed report is not counted where everyone reads the counts
        // (`sealed.ts`): a count that moves is a hint.
        `SELECT repo_id, kind, COUNT(*) AS n FROM issue
         WHERE state = 'open' AND sealed = 0 AND repo_id IN (${holes})
         GROUP BY repo_id, kind`,
      )
      .all(...chunk);
    for (const row of rows) {
      const current = counts.get(row.repo_id) ?? NO_COUNTS;
      counts.set(
        row.repo_id,
        row.kind === "pull"
          ? { ...current, openPulls: row.n }
          : { ...current, openIssues: row.n },
      );
    }
  }
  return counts;
}

/** Attach counts to a page of repos with one extra query for the page. */
export function withCounts(db: Database, repos: Repo[]): Repo[] {
  if (repos.length === 0) return repos;
  const counts = countsForRepos(
    db,
    repos.map((r) => r.id),
  );
  return repos.map((repo) => ({
    ...repo,
    counts: counts.get(repo.id) ?? NO_COUNTS,
  }));
}

export type CreateRepoError = "invalid_name" | "name_taken" | "git_init_failed";

export interface CreateRepoInput {
  ownerId: string;
  name: string;
  /** @default "private" */
  visibility?: "public" | "private";
  /** @default "" */
  description?: string;
  /** @default "main" */
  defaultBranch?: string;
}

export async function createRepo(
  db: Database,
  reposRoot: string,
  input: CreateRepoInput,
): Promise<Result<Repo, CreateRepoError>> {
  if (!isSafeName(input.name)) return err("invalid_name");
  const owner = db
    .query<
      { username: string },
      [string]
    >("SELECT username FROM user WHERE id = ?1")
    .get(input.ownerId);
  if (!owner) return err("invalid_name");

  const taken = db
    .query<
      { id: string },
      [string, string]
    >("SELECT id FROM repo WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE")
    .get(input.ownerId, input.name);
  if (taken) return err("name_taken");

  // Git first, row second: a row that exists is a repo you can clone.
  const dir = repoDir(reposRoot, owner.username, input.name);
  const branch = input.defaultBranch ?? "main";
  const init = await initBareRepo(dir, { defaultBranch: branch });
  if (!init.ok) return err("git_init_failed");
  await installHooks(dir);

  const repoId = id();
  rowOrUndo(dir, () =>
    db
      .query(
        `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .run(
        repoId,
        input.ownerId,
        input.name,
        input.visibility ?? "private",
        input.description ?? "",
        branch,
      ),
  );
  return ok(getRepoById(db, repoId)!);
}

export type ForkRepoError =
  | "invalid_name"
  | "name_taken"
  | "already_forked"
  | "fork_failed"
  /** The owner's forks in the last day reached `perDay` (#888). */
  | "limit";

const DAY_MS = 86_400_000;

/**
 * When an owner made each fork since `since`, oldest first — from the
 * ledger of forks made (`fork_made`), not the forks that still exist: a
 * deleted copy still counts toward the day it was made in.
 */
export function forksSince(db: Database, ownerId: string, since: string): string[] {
  return db
    .query<{ made_at: string }, [string, string]>(
      `SELECT made_at FROM fork_made WHERE owner_id = ?1 AND made_at >= ?2 ORDER BY made_at`,
    )
    .all(ownerId, since)
    .map((r) => r.made_at);
}

/** A marker the row's transaction throws when the day's forks are made. */
class OverLimit extends Error {}

/**
 * Fork a repo into another owner. The git objects are shared with the parent
 * via alternates (see forkBareRepo), so this is instant and storage-bounded.
 * The fork takes the parent's default branch, and its visibility unless a
 * narrower one is asked for: it is born with it, never public first (#888);
 * a private parent's fork is private whatever is asked. With `perDay`, the
 * owner's forks in the last 24 hours are counted in the same transaction
 * that writes the row, so two forks at once cannot both pass the limit.
 */
export async function forkRepo(
  db: Database,
  reposRoot: string,
  parent: Repo,
  ownerId: string,
  name?: string,
  options: {
    visibility?: "public" | "private";
    perDay?: number;
    now?: number;
    /**
     * The private repository the owner works the parent's sealed reports in
     * (`sealed.ts`): private whatever the parent is, no fork in the graph,
     * read by the parent's writers and crew. One per owner and parent. Not
     * a fork, so not one the daily limit counts.
     */
    sealed?: boolean;
    /** A guest's contribution fork (`contribute.ts`): marked in the row's own write. */
    contribution?: boolean;
    /** With `contribution`: guests' forks on the whole forge in the last 24 hours, counted in the same write. */
    forgePerDay?: number;
  } = {},
): Promise<Result<Repo, ForkRepoError>> {
  const sealed = options.sealed === true;
  const forkName = name ?? (sealed ? `${parent.name}-sealed` : parent.name);
  const visibility =
    sealed || parent.visibility === "private"
      ? "private"
      : (options.visibility ?? parent.visibility);
  const now = options.now ?? Date.now();
  const since = new Date(now - DAY_MS).toISOString();
  const overLimit = (): boolean =>
    !sealed &&
    ((options.perDay !== undefined && forksSince(db, ownerId, since).length >= options.perDay) ||
      (options.forgePerDay !== undefined && contributionForksSince(db, since) >= options.forgePerDay));
  if (overLimit()) return err("limit");
  if (!isSafeName(forkName)) return err("invalid_name");
  const owner = db
    .query<
      { username: string },
      [string]
    >("SELECT username FROM user WHERE id = ?1")
    .get(ownerId);
  if (!owner) return err("invalid_name");

  // One fork of a given parent per owner keeps the graph simple; this check
  // comes first so a re-fork reports "already_forked", not "name_taken".
  if (
    db
      .query(
        sealed
          ? "SELECT 1 FROM repo WHERE owner_id = ?1 AND sealed_for = ?2"
          : "SELECT 1 FROM repo WHERE owner_id = ?1 AND fork_parent_id = ?2",
      )
      .get(ownerId, parent.id)
  ) {
    return err("already_forked");
  }
  if (
    db
      .query(
        "SELECT 1 FROM repo WHERE owner_id = ?1 AND name = ?2 COLLATE NOCASE",
      )
      .get(ownerId, forkName)
  ) {
    return err("name_taken");
  }

  const parentDir = repoDir(reposRoot, parent.ownerName, parent.name);
  const forkDir = repoDir(reposRoot, owner.username, forkName);
  const forked = await forkBareRepo(parentDir, forkDir);
  if (!forked.ok) return err("fork_failed");
  await installHooks(forkDir);

  const repoId = id();
  try {
    rowOrUndo(forkDir, () =>
      db.transaction(() => {
        // Counted again with the write: the git copy above took a moment,
        // and another fork may have landed in it.
        if (overLimit()) throw new OverLimit();
        db.query(
          `INSERT INTO repo (id, owner_id, name, visibility, description, default_branch, fork_parent_id, sealed_for)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        ).run(
          repoId,
          ownerId,
          forkName,
          visibility,
          parent.description,
          parent.defaultBranch,
          sealed ? null : parent.id,
          sealed ? parent.id : null,
        );
        if (!sealed)
          db.query(`INSERT INTO fork_made (owner_id, made_at) VALUES (?1, ?2)`).run(
            ownerId,
            new Date(now).toISOString(),
          );
        if (options.contribution === true)
          db.query(`INSERT INTO contribution_fork (repo_id, made_at) VALUES (?1, ?2)`).run(
            repoId,
            new Date(now).toISOString(),
          );
      })(),
    );
  } catch (error) {
    if (error instanceof OverLimit) return err("limit");
    throw error;
  }
  return ok(getRepoById(db, repoId)!);
}

/**
 * Git first, row second — and when the row is refused (a constraint, an
 * operator's trigger), the directory git just made goes with it, so a
 * refusal leaves nothing on disk for anyone to fill it with.
 */
function rowOrUndo(dir: string, insert: () => unknown): void {
  try {
    insert();
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The private repository `ownerId` works `baseId`'s sealed reports in, if any. */
export function getSealedFork(
  db: Database,
  ownerId: string,
  baseId: string,
): Repo | undefined {
  const row = db
    .query<RepoRow, [string, string]>(
      `${SELECT} WHERE repo.owner_id = ?1 AND repo.sealed_for = ?2`,
    )
    .get(ownerId, baseId);
  return row ? toRepo(row) : undefined;
}

/** Repos forked directly from this one. */
/** The fork of `parentId` that `ownerId` holds, if any: one per owner. */
export function getForkOf(
  db: Database,
  ownerId: string,
  parentId: string,
): Repo | undefined {
  const row = db
    .query<
      RepoRow,
      [string, string]
    >(`${SELECT} WHERE repo.owner_id = ?1 AND repo.fork_parent_id = ?2`)
    .get(ownerId, parentId);
  return row ? toRepo(row) : undefined;
}

/** Every fork on the forge, whichever repository it follows. */
export function listAllForks(db: Database): Repo[] {
  return db
    .query<
      RepoRow,
      []
    >(`${SELECT} WHERE repo.fork_parent_id IS NOT NULL ORDER BY repo.id`)
    .all()
    .map(toRepo);
}

/** What a repository forks, nearest first, to `maxDepth` generations: one query. */
export function listAncestors(
  db: Database,
  repoId: string,
  maxDepth: number,
): Repo[] {
  return db
    .query<RepoRow, [string, number]>(
      `WITH RECURSIVE up(id, d) AS (
         SELECT fork_parent_id, 1 FROM repo
           WHERE id = ?1 AND fork_parent_id IS NOT NULL
         UNION ALL
         SELECT r.fork_parent_id, up.d + 1 FROM repo r JOIN up ON r.id = up.id
           WHERE r.fork_parent_id IS NOT NULL AND up.d < ?2)
       ${SELECT} JOIN up ON up.id = repo.id ORDER BY up.d`,
    )
    .all(repoId, maxDepth)
    .map(toRepo);
}

/** Every fork below a repository, to `maxDepth` generations: one query, by id. */
export function listDescendants(
  db: Database,
  repoId: string,
  maxDepth: number,
): Repo[] {
  return db
    .query<RepoRow, [string, number]>(
      `WITH RECURSIVE down(id, d) AS (
         SELECT id, 1 FROM repo WHERE fork_parent_id = ?1
         UNION ALL
         SELECT r.id, down.d + 1 FROM repo r JOIN down ON r.fork_parent_id = down.id
           WHERE down.d < ?2)
       ${SELECT} WHERE repo.id IN (SELECT id FROM down) ORDER BY repo.id`,
    )
    .all(repoId, maxDepth)
    .map(toRepo);
}

export function listForks(db: Database, repoId: string): Repo[] {
  return db
    .query<
      RepoRow,
      [string]
    >(`${SELECT} WHERE repo.fork_parent_id = ?1 ORDER BY repo.id`)
    .all(repoId)
    .map(toRepo);
}

/**
 * The repository this one was forked from, while that parent is still here
 * and the viewer may read it. A fork's lineage — the parent's name, and how
 * far the fork has drifted from it — is a fact about the parent, so a fork
 * that has been opened up never speaks for a parent that has not.
 */
export function forkParentFor(
  db: Database,
  repo: Repo,
  viewer: User | undefined,
): Repo | undefined {
  const parent =
    repo.forkParentId === null ? undefined : getRepoById(db, repo.forkParentId);
  return parent !== undefined && canRead(db, parent, viewer)
    ? parent
    : undefined;
}

/**
 * Forget a fork's parent. Only once the fork owns its objects (`detachFork`):
 * a row without a parent over a store that still borrows one is a fork that
 * breaks when the parent goes.
 */
export function clearForkParent(db: Database, repoId: string): void {
  db.query("UPDATE repo SET fork_parent_id = NULL WHERE id = ?1").run(repoId);
  forgetListings(db);
}

/** The forks of this repository the viewer may see — the list, and its count. */
export function visibleForks(
  db: Database,
  repoId: string,
  viewer: User | undefined,
): Repo[] {
  return listForks(db, repoId).filter((fork) => canRead(db, fork, viewer));
}

/** A fork the viewer may see, the visible forks beneath it, and how many lie one level further. */
export interface ForkNode {
  readonly repo: Repo;
  readonly forks: readonly ForkNode[];
  /** Visible forks of this one, counted but not listed; only the second level carries it. */
  readonly deeper: number;
}

const forksOfMany = (db: Database, ids: readonly string[]): Repo[] =>
  ids.length === 0
    ? []
    : db
        .query<RepoRow, string[]>(
          `${SELECT} WHERE repo.fork_parent_id IN (${ids.map(() => "?").join(",")}) ORDER BY repo.id`,
        )
        .all(...ids)
        .map(toRepo);

/** The visible forks of these parents, grouped by parent id: one query. */
export function visibleForksByParent(
  db: Database,
  parents: readonly Repo[],
  viewer: User | undefined,
): Map<string, Repo[]> {
  const byParent = new Map<string, Repo[]>();
  const forks = forksOfMany(db, parents.map((p) => p.id));
  // One query says which owners stand; a public repo of one is readable by
  // everyone (the first two rules of `canRead`), so only the rest ask again.
  const standing = new Set(
    forks.length === 0
      ? []
      : db
          .query<{ id: string }, string[]>(
            `SELECT repo.id AS id FROM repo WHERE repo.id IN (${forks.map(() => "?").join(",")}) AND ${OWNER_STANDING}`,
          )
          .all(...forks.map((f) => f.id))
          .map((r) => r.id),
  );
  for (const fork of forks) {
    const open = fork.visibility === "public" && standing.has(fork.id);
    if (fork.forkParentId === null || !(open || canRead(db, fork, viewer))) continue;
    const siblings = byParent.get(fork.forkParentId) ?? [];
    siblings.push(fork);
    byParent.set(fork.forkParentId, siblings);
  }
  return byParent;
}

/**
 * The visible forks of a repository, each with its own visible forks, and
 * for those a count of the visible forks one level further: three queries
 * at most, one per level. A fork the viewer cannot read hides itself and
 * everything under it.
 */
export function forkTree(
  db: Database,
  repoId: string,
  viewer: User | undefined,
): ForkNode[] {
  const first = visibleForks(db, repoId, viewer);
  const secondBy = visibleForksByParent(db, first, viewer);
  const second = [...secondBy.values()].flat();
  const thirdBy = visibleForksByParent(db, second, viewer);
  return first.map((repo) => ({
    repo,
    deeper: 0,
    forks: (secondBy.get(repo.id) ?? []).map((child) => ({
      repo: child,
      forks: [],
      deeper: thirdBy.get(child.id)?.length ?? 0,
    })),
  }));
}

export function getRepo(
  db: Database,
  ownerName: string,
  name: string,
): Repo | undefined {
  const row = db
    .query<
      RepoRow,
      [string, string]
    >(`${SELECT} WHERE ${BY_NAME}`)
    .get(ownerName, name);
  return row ? toRepo(row) : undefined;
}

/** Only a repository's visibility, by owner and name: for a page that needs the answer, not the row. */
export function repoVisibility(db: Database, ownerName: string, name: string): string | undefined {
  return (
    db
      .query<{ visibility: string }, [string, string]>(
        `SELECT repo.visibility FROM repo JOIN user ON user.id = repo.owner_id WHERE ${BY_NAME}`,
      )
      .get(ownerName, name)?.visibility ?? undefined
  );
}

export function getRepoById(db: Database, repoId: string): Repo | undefined {
  const row = db
    .query<RepoRow, [string]>(`${SELECT} WHERE repo.id = ?1`)
    .get(repoId);
  return row ? toRepo(row) : undefined;
}

/** Every repository one account owns, whatever its visibility. */
export function listReposOwnedBy(db: Database, ownerId: string): Repo[] {
  return db
    .query<RepoRow, [string]>(`${SELECT} WHERE repo.owner_id = ?1`)
    .all(ownerId)
    .map(toRepo);
}

/**
 * Several repos by id, in one query, keyed by id. What a pin list, an
 * activity feed, or any other page holding a bag of repo ids should ask,
 * instead of `getRepoById` in a loop.
 */
export function getReposByIds(
  db: Database,
  repoIds: readonly string[],
): Map<string, Repo> {
  const out = new Map<string, Repo>();
  const CHUNK = 400;
  const unique = [...new Set(repoIds)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<
        RepoRow,
        string[]
      >(`${SELECT} WHERE repo.id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})`)
      .all(...batch);
    for (const row of rows) out.set(row.id, toRepo(row));
  }
  return out;
}

export interface ListReposOptions {
  /** Case-insensitive substring of `owner/name` — the list page's filter box. */
  query?: string;
  /** Page size. @default LIST_LIMIT (max LIST_LIMIT_MAX) */
  limit?: number;
  /** Resume after this repo id (exclusive) — lists run newest first. */
  cursor?: string;
  /** Repositories that run an app first, each half newest first (not with `cursor`). */
  appsFirst?: boolean;
  /** Leave archived repositories out. @default false */
  withoutArchived?: boolean;
  /** Only archived repositories. @default false */
  archivedOnly?: boolean;
  /** Only this owner's repositories (a username, any case). */
  owner?: string;
}

// Visibility in SQL: public, owned, or owned by an org the viewer is on a
// team of. Site admins see everything. The same rule canRead applies, so a
// listing never shows a repo whose page would 404.
// The rule itself lives in visibility.ts, because the activity feed needs the
// same one and two copies of an access rule is how a forge grows a leak.
const VISIBLE = REPO_VISIBLE;

/** A listing's order: newest first, or apps first and then newest (`appsFirst`). */
const newestFirst = (options: ListReposOptions): string =>
  `${options.appsFirst === true ? "EXISTS (SELECT 1 FROM app WHERE app.repo_id = repo.id) DESC, " : ""}repo.id DESC`;

/** The WHERE and parameters a visible-to listing reads by; the page and its tag share them. */
function visibleClause(
  viewer: User | undefined,
  options: ListReposOptions,
): { where: string; params: (string | number)[] } {
  const params: (string | number)[] = [viewer?.id ?? ""];
  let where = viewer ? VISIBLE : PUBLIC_VISIBLE;
  if (options.owner !== undefined) {
    params.push(options.owner);
    where += ` AND user.username = ?${params.length} COLLATE NOCASE`;
  }
  if (options.query !== undefined && options.query.trim() !== "") {
    params.push(`%${likeEscape(options.query.trim())}%`);
    const p = params.length;
    where += ` AND (repo.name LIKE ?${p} ESCAPE '\\' COLLATE NOCASE
      OR user.username LIKE ?${p} ESCAPE '\\' COLLATE NOCASE)`;
  }
  if (options.cursor !== undefined) {
    params.push(options.cursor);
    where += ` AND repo.id < ?${params.length}`;
  }
  if (options.withoutArchived === true) where += " AND repo.archived_at IS NULL";
  if (options.archivedOnly === true) where += " AND repo.archived_at IS NOT NULL";
  params.push(pageLimit(options.limit));
  return { where, params };
}

export function listReposVisibleTo(
  db: Database,
  viewer: User | undefined,
  options: ListReposOptions = {},
): Repo[] {
  const { where, params } = visibleClause(viewer, options);
  const rows = db
    .query<RepoRow, (string | number)[]>(
      `${SELECT} WHERE ${where} ORDER BY ${newestFirst(options)} LIMIT ?${params.length}`,
    )
    .all(...params)
    .map(toRepo);
  return withCounts(db, rows);
}

/** The columns `toRepo` shows; `issue_seq` is not one, since a sealed report moves it. */
const SHOWN = [
  "repo.id", "repo.owner_id", "user.username", "repo.name", "repo.visibility", "repo.description",
  "repo.default_branch", "repo.protect_default", "repo.require_review", "repo.require_checks",
  "repo.autonomy", "repo.autonomy_direction", "repo.autonomy_ceiling_usd", "repo.autonomy_slots",
  "repo.planner_slots", "repo.reviewer_slots", "repo.polish_share", "repo.autonomy_by",
  "repo.crew_outsiders", "repo.decisions_by", "repo.plans_need_nod", "repo.direction_issue_id",
  "repo.fork_parent_id", "repo.sealed_for", "repo.archived_at", "repo.origin_id",
  "repo.origin_full_name", "repo.origin_html_url", "repo.last_fetch_at", "repo.fetch_error",
  "repo.origin_detached_at",
].join(", ");

/**
 * A marker that moves whenever the page `listReposVisibleTo` would answer
 * could differ, without building the page: one query that digests the shown
 * columns of the page's rows inside SQLite, the newest push of each, and the
 * open counts. Sealed reports are in neither the counts nor any event kind
 * read, so filing one moves no viewer's marker (`countsForRepos`). A viewer
 * sees only rows they may read, so two viewers who see different pages get
 * different markers.
 */
export function visibleReposMarker(
  db: Database,
  viewer: User | undefined,
  options: ListReposOptions = {},
): string {
  const { where, params } = visibleClause(viewer, options);
  const page = `SELECT repo.id AS id, json_array(${SHOWN}) AS shown FROM repo
    JOIN user ON user.id = repo.owner_id
    WHERE ${where} ORDER BY ${newestFirst(options)} LIMIT ?${params.length}`;
  const row = db
    .query<{ shown: string | null; pushes: string | null; counts: string | null }, (string | number)[]>(
      `WITH page AS (${page})
       SELECT
         (SELECT group_concat(shown, char(10)) FROM page) AS shown,
         (SELECT group_concat(repo_id || ':' || last, ',') FROM
            (SELECT repo_id, MAX(id) AS last FROM event
             WHERE kind = 'push' AND repo_id IN (SELECT id FROM page) GROUP BY repo_id ORDER BY repo_id)) AS pushes,
         (SELECT group_concat(repo_id || ':' || kind || ':' || n, ',') FROM
            (SELECT repo_id, kind, COUNT(*) AS n FROM issue
             WHERE state = 'open' AND sealed = 0 AND repo_id IN (SELECT id FROM page)
             GROUP BY repo_id, kind ORDER BY repo_id, kind)) AS counts`,
    )
    .get(...params);
  return Bun.hash(`${row?.shown ?? ""}|${row?.pushes ?? ""}|${row?.counts ?? ""}`).toString(36);
}

/**
 * Repos this viewer may write: their own, or an org's through a team with
 * write or admin access — `REPO_WRITABLE`, the SQL twin of `canWrite`, for a
 * list of rows rather than one permission check per row. An anonymous viewer
 * writes nothing.
 */
export function listReposWritableTo(
  db: Database,
  viewer: User | undefined,
  options: ListReposOptions = {},
): Repo[] {
  if (!viewer) return [];
  const params: (string | number)[] = [viewer.id];
  let where = REPO_WRITABLE;
  if (options.query !== undefined && options.query.trim() !== "") {
    params.push(`%${likeEscape(options.query.trim())}%`);
    const p = params.length;
    where += ` AND (repo.name LIKE ?${p} ESCAPE '\\' COLLATE NOCASE
      OR user.username LIKE ?${p} ESCAPE '\\' COLLATE NOCASE)`;
  }
  if (options.cursor !== undefined) {
    params.push(options.cursor);
    where += ` AND repo.id < ?${params.length}`;
  }
  if (options.withoutArchived === true) where += " AND repo.archived_at IS NULL";
  params.push(pageLimit(options.limit));
  const rows = db
    .query<RepoRow, (string | number)[]>(
      `${SELECT} WHERE ${where} ORDER BY ${newestFirst(options)} LIMIT ?${params.length}`,
    )
    .all(...params)
    .map(toRepo);
  return withCounts(db, rows);
}

/** Repos owned by one user or org, visible to the viewer. */
export function listReposByOwner(
  db: Database,
  ownerName: string,
  viewer: User | undefined,
  options: ListReposOptions = {},
): Repo[] {
  return listReposVisibleTo(db, viewer, { ...options, owner: ownerName });
}

/**
 * Delete a repo. Disk first, then the row: when the directory will not go,
 * the repository stays listed and a retry finds it (`delete_failed`). A
 * directory that is already missing leaves nothing to orphan, so the row still
 * goes and `delete_failed` is still reported.
 * Before removing the objects, detach every fork that borrows them (repack so
 * the fork owns its objects, then drop its alternates link) — otherwise a
 * fork would be silently corrupted. This is the detach-before-delete rule.
 */
export async function deleteRepo(
  db: Database,
  reposRoot: string,
  repo: Repo,
): Promise<Result<void, "delete_failed" | "has_pulls">> {
  // A pull names its head by this row, and a pull with no head row reads as
  // one from its base's own branch, which runs without approval. So a fork a
  // pull was sent from stays; nothing below is touched.
  if (
    db
      .query(
        `SELECT 1 FROM pull p JOIN issue i ON i.id = p.issue_id
          WHERE p.head_repo_id = ?1 AND i.repo_id <> ?1 LIMIT 1`,
      )
      .get(repo.id) !== null
  )
    return err("has_pulls");
  const forks = listForks(db, repo.id);
  for (const fork of forks) {
    const forkDir = repoDir(reposRoot, fork.ownerName, fork.name);
    const detached = await detachFork(forkDir);
    if (!detached.ok) {
      // Refuse rather than orphan a fork's objects.
      log.error("cannot detach fork before parent delete", {
        parent: `${repo.ownerName}/${repo.name}`,
        fork: `${fork.ownerName}/${fork.name}`,
      });
      return err("delete_failed");
    }
    clearForkParent(db, fork.id);
  }

  const dir = repoDir(reposRoot, repo.ownerName, repo.name);
  // A pooled `cat-file` holds this directory open. Closing it first is what
  // keeps the space actually free after the unlink instead of pinned to a
  // descriptor nobody will ever read again.
  closeReader(dir);
  const present = await repoDirExists(dir);
  // The directory goes first: when it will not, the row stays, so the
  // repository is still listed and a retry finds it. With no directory there
  // is nothing to orphan, so the row goes and the missing repository is
  // still reported.
  const removed = await deleteRepoDir(dir);
  if (!removed.ok && present) return err("delete_failed");
  db.query("DELETE FROM repo WHERE id = ?1").run(repo.id);
  forgetRepoCursors(db, repo.id);
  forgetListings(db);
  if (!removed.ok) return err("delete_failed");
  return ok();
}

// Permissions. A personal repo is governed by ownership; an org's repo by the
// caller's team access in that org. Site admins see and do everything. An
// agent on a repo's crew reads it — and only that: the crew works from
// forks, so an agent writes what it owns and proposes the rest, and
// everything from write up stays with people.

function personalOrDirect(repo: Repo, user: User | undefined): boolean {
  return user !== undefined && (user.id === repo.ownerId || user.isAdmin);
}

export function onCrew(db: Database, repo: Repo, user: User | undefined): boolean {
  if (user === undefined || user.kind !== "agent") return false;
  return (
    db
      .query<
        { n: number },
        [string, string]
      >("SELECT 1 AS n FROM repo_crew WHERE repo_id = ?1 AND user_id = ?2")
      .get(repo.id, user.id) !== null
  );
}

/** Resolve org access for an org-owned repo, or "none" for a personal repo. */
function orgAccessFor(
  db: Database,
  repo: Repo,
  user: User | undefined,
): Access {
  const owner = getUserById(db, repo.ownerId);
  if (owner?.kind !== "org") return "none";
  return orgAccess(db, repo.ownerId, user);
}

/**
 * Whether the repo's owner is in good standing. A suspended or removed
 * account's repositories read as absent to everyone but a site admin
 * (`OWNER_STANDING`, its SQL twin).
 */
export function ownerInStanding(db: Database, repo: Repo): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT 1 AS n FROM repo WHERE repo.id = ?1 AND ${OWNER_STANDING}`,
      )
      .get(repo.id) !== null
  );
}

export function canRead(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  if (!ownerInStanding(db, repo)) return user?.isAdmin === true;
  if (repo.visibility === "public") return true;
  if (personalOrDirect(repo, user)) return true;
  if (onCrew(db, repo, user)) return true;
  // The work on a sealed report is read by whoever may see the report on
  // its base: the base's writers and crew, and nobody else (`sealed.ts`).
  if (repo.sealedFor !== null) {
    const base = getRepoById(db, repo.sealedFor);
    return (
      base !== undefined &&
      (canWrite(db, base, user) || onCrew(db, base, user))
    );
  }
  return accessAllows(orgAccessFor(db, repo, user), "read");
}

export function canWrite(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  if (personalOrDirect(repo, user)) return true;
  return accessAllows(orgAccessFor(db, repo, user), "write");
}

/**
 * Who may enter an app, its previews and its terminal. A public app is open
 * to anyone. A private one answers to the people who can write the
 * repository and to its crew — never to everyone who can read it, so making
 * a repository public changes nobody's way into its app (#620) — and to the
 * people it names (#752), who may enter it and its previews and nothing
 * else: not its terminal (`named: false`), not its code, not its crew.
 */
export function canEnterApp(
  db: Database,
  repo: Repo,
  app: { readonly id: string; readonly access: "public" | "private" },
  user: User | undefined,
  { named = true }: { named?: boolean } = {},
): boolean {
  if (app.access === "public") return true;
  if (canWrite(db, repo, user) || onCrew(db, repo, user)) return true;
  return (
    named &&
    user !== undefined &&
    user.kind === "user" &&
    isActive(user) &&
    isAppMember(db, app.id, user.id)
  );
}

/**
 * `canEnterApp` for a whole page of apps, in a fixed number of reads: the
 * ids of the apps `user` may enter. The same rule, clause for clause — a
 * public app is open; a private one answers to whoever may write the
 * repository or is on its crew (`writableRepoIds`, the SQL twin of
 * `canWrite` with the crew in it), and, when `named`, to an active person
 * the app names — asked once for every private app rather than per row.
 */
export function enterableApps(
  db: Database,
  rows: readonly {
    readonly repo: Repo;
    readonly app: { readonly id: string; readonly access: "public" | "private" };
  }[],
  user: User | undefined,
  { named = true }: { named?: boolean } = {},
): Set<string> {
  const out = new Set<string>();
  const closed = rows.filter((r) => {
    if (r.app.access === "public") out.add(r.app.id);
    return r.app.access !== "public";
  });
  if (closed.length === 0 || user === undefined) return out;
  const writable = writableRepoIds(
    db,
    user,
    closed.map((r) => r.repo.id),
  );
  const naming =
    named && user.kind === "user" && isActive(user)
      ? appsNaming(
          db,
          user.id,
          closed.map((r) => r.app.id),
        )
      : new Set<string>();
  for (const r of closed)
    if (writable.has(r.repo.id) || naming.has(r.app.id)) out.add(r.app.id);
  return out;
}

/**
 * Money, the crew roster, autonomy limits and a run's own cost describe
 * running the app, not what it is — a stranger who can only read a public
 * app sees what it does and what it has shipped, never what it costs or
 * who is on it. The same test as `canWrite`, named for what it decides
 * here, so every surface that shows one of these facts asks this one
 * question rather than inventing its own.
 */
export function canSeeOwnerFacts(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  return canWrite(db, repo, user);
}

/**
 * `canSeeOwnerFacts` for many repositories at once: the ids of those whose
 * owner facts the user may see. The same rules as `canWrite` — owner, site
 * admin, or a write/admin team in the owning org (no crew grant, unlike
 * `REPO_WRITABLE`) — answered from one read of the user's teams, so a list
 * does not pay a user lookup and a permission query per row.
 */
export function ownerFactRepoIds(
  db: Database,
  repos: readonly Repo[],
  user: User | undefined,
): Set<string> {
  const out = new Set<string>();
  if (user === undefined) return out;
  const orgs = user.isAdmin
    ? new Map<string, Access>()
    : orgAccessByOrg(db, user);
  for (const repo of repos)
    if (
      personalOrDirect(repo, user) ||
      accessAllows(orgs.get(repo.ownerId) ?? "none", "write")
    )
      out.add(repo.id);
  return out;
}

/**
 * Which of these repositories the user may write — `canWrite` for many rows
 * in one query per chunk, through `REPO_WRITABLE`. The dashboard's inbox
 * asks this for every crew pull it shows; asked per row that was a
 * permission check, and a user lookup, per pull.
 */
export function writableRepoIds(
  db: Database,
  user: User | undefined,
  repoIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  if (user === undefined) return out;
  const unique = [...new Set(repoIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ id: string }, string[]>(
        `SELECT repo.id FROM repo
         WHERE repo.id IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
           AND ${REPO_WRITABLE}`,
      )
      .all(user.id, ...batch);
    for (const row of rows) out.add(row.id);
  }
  return out;
}

/** Admin over a repo (settings, delete, webhooks, protection). */
export function canAdmin(
  db: Database,
  repo: Repo,
  user: User | undefined,
): boolean {
  if (personalOrDirect(repo, user))
    // A guest's contribution fork is theirs to push to, not to administer.
    return user?.id !== repo.ownerId || user.isAdmin || !isContributionFork(db, repo.id);
  return accessAllows(orgAccessFor(db, repo, user), "admin");
}

/** Who answers the decisions a repository asks of its owner. */
export const DECISIONS_BY = ["me", "decider", "decider_tell"] as const;
export type DecisionsBy = (typeof DECISIONS_BY)[number];
export const isDecisionsBy = (v: unknown): v is DecisionsBy =>
  typeof v === "string" && (DECISIONS_BY as readonly string[]).includes(v);

export interface RepoSettings {
  visibility?: "public" | "private";
  description?: string;
  protectDefault?: boolean;
  /** Require an approval of a pull's current head before it may merge. */
  requireReview?: boolean;
  /** Require a passing deploy of a pull's current head before it may merge. */
  requireChecks?: boolean;
  /** The caller must have pointed git HEAD at this branch first. */
  defaultBranch?: string;
  autonomy?: Autonomy;
  autonomyDirection?: string;
  autonomyCeilingUsd?: number;
  autonomySlots?: number;
  plannerSlots?: number;
  reviewerSlots?: number;
  polishShare?: number;
  /** Who the forge acts as when it assigns and lands on its own. */
  autonomyBy?: string | null;
  /** Whether someone who cannot write here may start or steer a run. */
  crewOutsiders?: boolean;
  decisionsBy?: DecisionsBy;
  /** Archive (true) or wake (false); the time is stamped here. */
  archived?: boolean;
  plansNeedNod?: boolean;
}

/** The repositories still awake: what Yours lists before anyone types a filter. */
export const withoutArchived = (repos: readonly Repo[]): Repo[] =>
  repos.filter((repo) => repo.archivedAt === null);

/** The one line said wherever the crew declines to start a run here. */
export const ARCHIVED_WHY = "This repository is archived; wake it to start a run.";

/**
 * Update the mutable repo fields, leaving unspecified ones untouched.
 * Archiving is not one of them: it is a transition, `moveArchived`.
 */
export function updateRepoSettings(
  db: Database,
  repo: Repo,
  settings: Omit<RepoSettings, "archived">,
): Repo {
  db.query(
    `UPDATE repo SET visibility = ?1, description = ?2, protect_default = ?3,
       default_branch = ?4, require_review = ?5, require_checks = ?7,
       autonomy = ?8, autonomy_direction = ?9, autonomy_ceiling_usd = ?10,
       autonomy_slots = ?11, autonomy_by = ?12, crew_outsiders = ?13, decisions_by = ?14,
       plans_need_nod = ?15, planner_slots = ?16, reviewer_slots = ?17, polish_share = ?18
     WHERE id = ?6`,
  ).run(
    settings.visibility ?? repo.visibility,
    settings.description ?? repo.description,
    (settings.protectDefault ?? repo.protectDefault) ? 1 : 0,
    settings.defaultBranch ?? repo.defaultBranch,
    (settings.requireReview ?? repo.requireReview) ? 1 : 0,
    repo.id,
    (settings.requireChecks ?? repo.requireChecks) ? 1 : 0,
    settings.autonomy ?? repo.autonomy,
    settings.autonomyDirection ?? repo.autonomyDirection,
    settings.autonomyCeilingUsd ?? repo.autonomyCeilingUsd,
    settings.autonomySlots ?? repo.autonomySlots,
    settings.autonomyBy === undefined ? repo.autonomyBy : settings.autonomyBy,
    (settings.crewOutsiders ?? repo.crewOutsiders) ? 1 : 0,
    settings.decisionsBy ?? repo.decisionsBy,
    (settings.plansNeedNod ?? repo.plansNeedNod) ? 1 : 0,
    settings.plannerSlots ?? repo.plannerSlots,
    settings.reviewerSlots ?? repo.reviewerSlots,
    settings.polishShare ?? repo.polishShare,
  );
  forgetListings(db);
  return getRepoById(db, repo.id)!;
}

/**
 * Archive (true) or wake (false) in one conditional write. True only when
 * this call moved the repository: of two at once, one moves it and the
 * other finds it already there, whatever either read before.
 */
export function moveArchived(
  db: Database,
  repoId: string,
  archived: boolean,
  at: string = new Date().toISOString(),
): boolean {
  // RETURNING counts the repository, not the trigger's write to `front_epoch`.
  const changes = archived
    ? db
        .query("UPDATE repo SET archived_at = ?2 WHERE id = ?1 AND archived_at IS NULL RETURNING id")
        .all(repoId, at).length
    : db
        .query("UPDATE repo SET archived_at = NULL WHERE id = ?1 AND archived_at IS NOT NULL RETURNING id")
        .all(repoId).length;
  if (changes === 1) forgetListings(db);
  return changes === 1;
}

/** Repositories the crew drives on its own, assisted or autonomous. */
/** Every repository the forge holds, for the snapshot: nothing is left out. */
export function listEveryRepo(db: Database): Repo[] {
  return db
    .query<RepoRow, []>(`${SELECT} ORDER BY owner_name, repo.name`)
    .all()
    .map(toRepo);
}

export function listAutonomousRepos(db: Database): Repo[] {
  return db
    .query<
      RepoRow,
      []
    >(`${SELECT} WHERE repo.autonomy != 'off' ORDER BY repo.name`)
    .all()
    .map(toRepo);
}

export function setDirectionIssue(
  db: Database,
  repoId: string,
  issueId: string | null,
): void {
  db.query("UPDATE repo SET direction_issue_id = ?2 WHERE id = ?1").run(
    repoId,
    issueId,
  );
}

// Reads a display lists from (display/known.ts, display/items.ts).

/**
 * When each repository was created and last pushed to (the newest `push`
 * event, null when there is none), for a list of forks: one query per chunk.
 */
export function repoDatesFor(
  db: Database,
  repoIds: readonly string[],
): Map<string, { createdAt: string; pushedAt: string | null }> {
  const out = new Map<string, { createdAt: string; pushedAt: string | null }>();
  for (let i = 0; i < repoIds.length; i += 500) {
    const chunk = repoIds.slice(i, i + 500);
    const marks = chunk.map((_, j) => `?${j + 1}`).join(",");
    const rows = db
      .query<{ id: string; created_at: string; pushed_at: string | null }, string[]>(
        `SELECT repo.id, repo.created_at,
                (SELECT MAX(event.created_at) FROM event
                  WHERE event.repo_id = repo.id AND event.kind = 'push') AS pushed_at
           FROM repo WHERE repo.id IN (${marks})`,
      )
      .all(...chunk);
    for (const r of rows)
      out.set(r.id, { createdAt: r.created_at, pushedAt: r.pushed_at });
  }
  return out;
}

/**
 * Every repo one user or org owns, whoever looks: for a display, whose
 * showcased demos are published from private repositories too
 * (`display/items.ts`). Never a listing a person sees as repositories.
 */
export function listAllReposByOwner(db: Database, ownerName: string, limit: number): Repo[] {
  return db
    .query<RepoRow, [string, number]>(`${SELECT} WHERE user.username = ?1 COLLATE NOCASE ORDER BY repo.id DESC LIMIT ?2`)
    .all(ownerName, limit)
    .map(toRepo);
}

/**
 * Which of these repositories the viewer may read — `REPO_VISIBLE` (or
 * `PUBLIC_VISIBLE` signed out) for many rows in one query per chunk: the
 * rule every listing applies, so a row never links a page that would 404.
 */
export function readableRepoIds(
  db: Database,
  viewer: User | undefined,
  repoIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  const unique = [...new Set(repoIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<{ id: string }, string[]>(
        `SELECT repo.id FROM repo
         WHERE repo.id IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
           AND ${viewer ? REPO_VISIBLE : PUBLIC_VISIBLE}`,
      )
      .all(viewer?.id ?? "", ...batch);
    for (const row of rows) out.add(row.id);
  }
  return out;
}

/** Every repository a site admin owns (a person, never an agent), its owner in standing. */
export function listAdminOwnedRepos(db: Database): Repo[] {
  return db
    .query<RepoRow, []>(`${SELECT} WHERE user.is_admin = 1 AND user.is_agent = 0 AND ${OWNER_STANDING} ORDER BY owner_name, repo.name`)
    .all()
    .map(toRepo);
}
