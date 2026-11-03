/**
 * Origins: connected accounts on other forges, and the bookkeeping that
 * hangs off them. Pure data access — no authorization, no events, no HTTP —
 * exactly like the rest of `core/`.
 *
 * The token is the one thing here that is not ordinary data. It is stored
 * sealed (`kernel/secret.ts`), bound to its own row id, and it leaves this
 * module by exactly one door — `sealedSecrets`, which hands back ciphertext
 * and nothing else. The `Origin` value every other module sees has no token
 * field at all, the same trick `Webhook.hasSecret` uses, for the same reason:
 * a value that cannot carry a secret cannot leak one.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { seal } from "../kernel/secret.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { Origin, OriginKind, RemoteRepo } from "../origins/types.ts";
import type { RepoDetached } from "./repos.ts";

export type { Origin, OriginKind } from "../origins/types.ts";

interface OriginRow {
  id: string;
  user_id: string;
  kind: OriginKind;
  api_url: string;
  web_url: string;
  login: string;
  token_enc: string;
  created_at: string;
  last_sync_at: string | null;
  last_error: string;
  auth_kind: "pat" | "oauth";
  refresh_token_enc: string;
  expires_at: string | null;
  needs_reauth: number;
  software: string;
}

function toOrigin(row: OriginRow): Origin {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    apiUrl: row.api_url,
    webUrl: row.web_url,
    login: row.login,
    createdAt: row.created_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    authKind: row.auth_kind,
    expiresAt: row.expires_at,
    needsReauth: row.needs_reauth === 1,
    software: row.software,
  };
}

export interface CreateOriginInput {
  userId: string;
  kind: OriginKind;
  apiUrl: string;
  webUrl: string;
  login: string;
  /** The plaintext token. Sealed here and never held anywhere else. */
  token: string;
  /** @default "pat" */
  authKind?: "pat" | "oauth";
  /** OAuth only: the rotating refresh token, sealed alongside. */
  refreshToken?: string;
  /** OAuth only: when the access token stops working. */
  expiresAt?: string | null;
  /** `forge` for another forge; see `Origin.software`. */
  software?: string;
}

export type CreateOriginError = "already_connected";

/**
 * Connect an account. The row id is minted first because it is the sealed
 * token's additional authenticated data — move the ciphertext to another row
 * and it stops decrypting.
 */
export function createOrigin(
  db: Database,
  dataDir: string,
  input: CreateOriginInput,
): Result<Origin, CreateOriginError> {
  const existing = db
    .query<
      OriginRow,
      [string, string, string]
    >("SELECT * FROM origin WHERE user_id = ?1 AND api_url = ?2 AND login = ?3")
    .get(input.userId, input.apiUrl, input.login);
  if (existing) return err("already_connected");

  const originId = id();
  db.query(
    `INSERT INTO origin (id, user_id, kind, api_url, web_url, login, token_enc,
                         auth_kind, refresh_token_enc, expires_at, software)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).run(
    originId,
    input.userId,
    input.kind,
    input.apiUrl,
    input.webUrl,
    input.login,
    seal(dataDir, input.token, originId),
    input.authKind ?? "pat",
    input.refreshToken === undefined || input.refreshToken === ""
      ? ""
      : seal(dataDir, input.refreshToken, originId),
    input.expiresAt ?? null,
    input.software ?? "",
  );
  return ok(getOriginById(db, originId)!);
}

export function getOriginById(
  db: Database,
  originId: string,
): Origin | undefined {
  const row = db
    .query<OriginRow, [string]>("SELECT * FROM origin WHERE id = ?1")
    .get(originId);
  return row ? toOrigin(row) : undefined;
}

/**
 * An origin as its owner sees it. Anyone else gets `undefined` — and callers
 * turn that into `not_found`, never `forbidden`, so one user's connected
 * accounts are invisible to every other (invariant 9).
 */
export function getOriginFor(
  db: Database,
  userId: string,
  originId: string,
): Origin | undefined {
  const origin = getOriginById(db, originId);
  return origin && origin.userId === userId ? origin : undefined;
}

export function listOrigins(db: Database, userId: string): Origin[] {
  return db
    .query<
      OriginRow,
      [string]
    >("SELECT * FROM origin WHERE user_id = ?1 ORDER BY id")
    .all(userId)
    .map(toOrigin);
}

/** Every origin on the forge, for the sync worker's due sweep. */
export function listAllOrigins(db: Database): Origin[] {
  return db
    .query<OriginRow, []>("SELECT * FROM origin ORDER BY id")
    .all()
    .map(toOrigin);
}

/**
 * Disconnect. Mirrored repos keep their git objects and their imported rows
 * — `repo.origin_id` goes NULL by the schema's ON DELETE SET NULL — so
 * nothing a user could still want to read disappears; it simply stops syncing.
 */
export function deleteOrigin(
  db: Database,
  userId: string,
  originId: string,
): boolean {
  return (
    db
      .query("DELETE FROM origin WHERE id = ?1 AND user_id = ?2")
      .run(originId, userId).changes > 0
  );
}

export function recordSync(
  db: Database,
  originId: string,
  outcome: { at: string; error?: string },
): void {
  db.query(
    "UPDATE origin SET last_sync_at = ?1, last_error = ?2 WHERE id = ?3",
  ).run(outcome.at, outcome.error ?? "", originId);
}

/**
 * The sealed halves of an origin's credential. This is the only read path to
 * a secret in the whole forge, and it is deliberately unglamorous: callers
 * get ciphertext and must go through `kernel/secret.ts` to open it, bound to
 * this row's id. Nothing that renders, logs or serialises an origin ever
 * touches this function.
 */
export function sealedSecrets(
  db: Database,
  originId: string,
): { token: string; refresh: string } | undefined {
  const row = db
    .query<
      { token_enc: string; refresh_token_enc: string },
      [string]
    >("SELECT token_enc, refresh_token_enc FROM origin WHERE id = ?1")
    .get(originId);
  if (!row) return undefined;
  return { token: row.token_enc, refresh: row.refresh_token_enc };
}

/**
 * Store a refreshed credential. Written in one statement, before the new
 * access token is used for anything: refresh-token rotation means a new
 * refresh token we fail to persist is a permanently dead origin, so the
 * write has to happen first and cannot be half-done.
 */
export function storeRefreshed(
  db: Database,
  dataDir: string,
  originId: string,
  next: { token: string; refresh?: string; expiresAt?: string | null },
): void {
  // A refresh never clears `needs_reauth`: one that races a refusal (the
  // operator guard's sweep, a dead grant) must not undo it. Only connecting
  // again — `renewOrigin`, after the guard passed — brings an origin back.
  db.query(
    `UPDATE origin SET token_enc = ?1,
       refresh_token_enc = CASE WHEN ?2 = '' THEN refresh_token_enc ELSE ?2 END,
       expires_at = ?3,
       last_error = CASE WHEN needs_reauth = 1 THEN last_error ELSE '' END
     WHERE id = ?4`,
  ).run(
    seal(dataDir, next.token, originId),
    next.refresh === undefined || next.refresh === ""
      ? ""
      : seal(dataDir, next.refresh, originId),
    next.expiresAt ?? null,
    originId,
  );
}

/** The origin a user already connected for this account on this forge. */
export function findOrigin(
  db: Database,
  userId: string,
  apiUrl: string,
  login: string,
): Origin | undefined {
  const row = db
    .query<
      OriginRow,
      [string, string, string]
    >("SELECT * FROM origin WHERE user_id = ?1 AND api_url = ?2 AND login = ?3")
    .get(userId, apiUrl, login);
  return row ? toOrigin(row) : undefined;
}

/**
 * Put a working credential on an origin that lost its own — the re-authorize
 * path. The row, its id and every mirror hanging off it stay exactly as they
 * were; only the sealed halves, their kind and the human flag change, in one
 * statement, for the same reason `storeRefreshed` writes in one.
 */
export function renewOrigin(
  db: Database,
  dataDir: string,
  originId: string,
  next: {
    token: string;
    authKind: "pat" | "oauth";
    refreshToken?: string;
    expiresAt?: string | null;
  },
): void {
  db.query(
    `UPDATE origin SET token_enc = ?1, refresh_token_enc = ?2, auth_kind = ?3,
       expires_at = ?4, needs_reauth = 0, last_error = ''
     WHERE id = ?5`,
  ).run(
    seal(dataDir, next.token, originId),
    next.refreshToken === undefined || next.refreshToken === ""
      ? ""
      : seal(dataDir, next.refreshToken, originId),
    next.authKind,
    next.expiresAt ?? null,
    originId,
  );
}

/**
 * Mark an origin as needing a human. This is the `invalid_grant` outcome —
 * the refresh token is gone or revoked — and retrying it forever is how a
 * sync worker turns one expired credential into a permanent error loop.
 */
export function markNeedsReauth(
  db: Database,
  originId: string,
  reason: string,
): void {
  db.query(
    "UPDATE origin SET needs_reauth = 1, last_error = ?1 WHERE id = ?2",
  ).run(reason, originId);
}

// ---- the origin's repo list (the import picker's rows) ----

export interface OriginRepoRow {
  readonly originId: string;
  readonly remoteId: string;
  readonly fullName: string;
  readonly description: string;
  readonly private: boolean;
  readonly fork: boolean;
  readonly defaultBranch: string;
  readonly cloneUrl: string;
  readonly htmlUrl: string;
  readonly pushedAt: string | null;
  readonly canPush: boolean;
  readonly seenAt: string;
  /**
   * `owner/name` of the repo this one forks, when the origin says so. What
   * lets "contribute to a repo I cannot push to" find the fork I already
   * have instead of asking the origin for a second one.
   */
  readonly forkOf: string | null;
  /** The local repo mirroring this one, when there is one. */
  readonly mirroredAs: string | null;
  /**
   * Open counts as the origin states them. When
   * `openIssuesIncludingPulls` is true the origin (GitHub) gave one number
   * covering both, and `openPulls` is unknown rather than zero.
   */
  readonly openIssues: number;
  readonly openPulls: number;
  readonly openIssuesIncludingPulls: boolean;
  /** KiB, as the origin last reported it; 0 when unknown. */
  readonly sizeKb: number;
}

const REPO_SELECT = `
  SELECT origin_repo.*, repo.id AS mirrored_id
  FROM origin_repo
  LEFT JOIN repo ON repo.origin_id = origin_repo.origin_id
                AND repo.origin_remote_id = origin_repo.remote_id`;

interface RawOriginRepo {
  origin_id: string;
  remote_id: string;
  full_name: string;
  description: string;
  private: number;
  fork: number;
  default_branch: string;
  clone_url: string;
  html_url: string;
  pushed_at: string | null;
  can_push: number;
  seen_at: string;
  fork_of: string | null;
  open_issues: number;
  open_pulls: number;
  counts_include_pulls: number;
  size_kb: number;
  mirrored_id: string | null;
}

const toOriginRepo = (row: RawOriginRepo): OriginRepoRow => ({
  originId: row.origin_id,
  remoteId: row.remote_id,
  fullName: row.full_name,
  description: row.description,
  private: row.private === 1,
  fork: row.fork === 1,
  defaultBranch: row.default_branch,
  cloneUrl: row.clone_url,
  htmlUrl: row.html_url,
  pushedAt: row.pushed_at,
  canPush: row.can_push === 1,
  seenAt: row.seen_at,
  forkOf: row.fork_of,
  mirroredAs: row.mirrored_id,
  openIssues: row.open_issues,
  openPulls: row.open_pulls,
  openIssuesIncludingPulls: row.counts_include_pulls === 1,
  sizeKb: row.size_kb,
});

/**
 * One upsert, shared by the full refresh and the single-row remember, so the
 * picker's cache can never gain a column in one path and miss it in the other.
 */
const UPSERT_ORIGIN_REPO = `
  INSERT INTO origin_repo
    (origin_id, remote_id, full_name, description, private, fork,
     default_branch, clone_url, html_url, pushed_at, can_push, seen_at,
     open_issues, open_pulls, counts_include_pulls, fork_of, size_kb)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
  ON CONFLICT (origin_id, remote_id) DO UPDATE SET
    full_name = excluded.full_name,
    description = excluded.description,
    private = excluded.private,
    fork = excluded.fork,
    default_branch = excluded.default_branch,
    clone_url = excluded.clone_url,
    html_url = excluded.html_url,
    pushed_at = excluded.pushed_at,
    can_push = excluded.can_push,
    seen_at = excluded.seen_at,
    open_issues = excluded.open_issues,
    open_pulls = excluded.open_pulls,
    counts_include_pulls = excluded.counts_include_pulls,
    size_kb = excluded.size_kb,
    -- A listing that does not report the parent must not forget one we
    -- already know: listRepos omits it on both forges, getRepo states it.
    fork_of = COALESCE(excluded.fork_of, origin_repo.fork_of)`;

/** The bound parameters of one `UPSERT_ORIGIN_REPO`, in order. */
const upsertArgs = (
  originId: string,
  repo: RemoteRepo,
  seenAt: string,
): (string | number | null)[] => [
  originId,
  repo.remoteId,
  repo.fullName,
  repo.description,
  repo.private ? 1 : 0,
  repo.fork ? 1 : 0,
  repo.defaultBranch,
  repo.cloneUrl,
  repo.htmlUrl,
  repo.pushedAt,
  repo.permissions.push ? 1 : 0,
  seenAt,
  repo.openIssues,
  repo.openPulls,
  repo.openIssuesIncludesPulls ? 1 : 0,
  repo.parent,
  Number.isSafeInteger(repo.sizeKb) && repo.sizeKb > 0 ? repo.sizeKb : 0,
];

/**
 * Refresh the cached picker rows. Repos the origin no longer reports are
 * dropped — but only the ones we did not mirror, because a mirror is a
 * local repository the user owns and its row is not the origin's to revoke.
 */
export function cacheOriginRepos(
  db: Database,
  originId: string,
  repos: readonly RemoteRepo[],
): void {
  const seenAt = new Date().toISOString();
  const write = db.transaction(() => {
    const upsert = db.query(UPSERT_ORIGIN_REPO);
    for (const repo of repos) {
      if (repo.remoteId === "" || repo.fullName === "") continue;
      upsert.run(...upsertArgs(originId, repo, seenAt));
    }
    db.query(
      `DELETE FROM origin_repo
       WHERE origin_id = ?1 AND seen_at < ?2
         AND remote_id NOT IN (
           SELECT origin_remote_id FROM repo
           WHERE origin_id = ?1 AND origin_remote_id IS NOT NULL)`,
    ).run(originId, seenAt);
  });
  write();
}

/** Remember one remote repo without touching the rest of the cache — what
 * mirroring a repo the picker has not listed yet needs. */
export function rememberOriginRepo(
  db: Database,
  originId: string,
  repo: RemoteRepo,
): void {
  db.query(UPSERT_ORIGIN_REPO).run(
    ...upsertArgs(originId, repo, new Date().toISOString()),
  );
}

export function listOriginRepos(
  db: Database,
  originId: string,
): OriginRepoRow[] {
  return db
    .query<
      RawOriginRepo,
      [string]
    >(`${REPO_SELECT} WHERE origin_repo.origin_id = ?1 ORDER BY origin_repo.full_name COLLATE NOCASE`)
    .all(originId)
    .map(toOriginRepo);
}

export function getOriginRepo(
  db: Database,
  originId: string,
  fullName: string,
): OriginRepoRow | undefined {
  const row = db
    .query<
      RawOriginRepo,
      [string, string]
    >(`${REPO_SELECT} WHERE origin_repo.origin_id = ?1 AND origin_repo.full_name = ?2 COLLATE NOCASE`)
    .get(originId, fullName);
  return row ? toOriginRepo(row) : undefined;
}

// ---- sync watermarks ----

/**
 * A small keyed store per origin: where each list left off, when the origin
 * is next due, and how long a rate limit asked us to wait. Everything in it
 * is a cache — losing it costs one full re-import, never any data.
 */
export function getCursor(
  db: Database,
  originId: string,
  key: string,
): string | undefined {
  const row = db
    .query<
      { value: string },
      [string, string]
    >("SELECT value FROM origin_cursor WHERE origin_id = ?1 AND key = ?2")
    .get(originId, key);
  return row?.value;
}

export function setCursor(
  db: Database,
  originId: string,
  key: string,
  value: string,
): void {
  db.query(
    `INSERT INTO origin_cursor (origin_id, key, value) VALUES (?1, ?2, ?3)
     ON CONFLICT (origin_id, key) DO UPDATE SET value = excluded.value`,
  ).run(originId, key, value);
}

export function clearCursor(db: Database, originId: string, key: string): void {
  db.query("DELETE FROM origin_cursor WHERE origin_id = ?1 AND key = ?2").run(
    originId,
    key,
  );
}

// ---- the mirror link on a repo ----

export interface MirrorLink {
  readonly origin: Origin;
  /** `owner/name` at the origin. */
  readonly fullName: string;
  readonly remoteId: string;
  readonly htmlUrl: string;
  readonly cloneUrl: string;
}

/**
 * The origin a repo mirrors, or undefined for a native repo. Everything that
 * behaves differently on a mirror asks this one question.
 */
export function originForRepo(
  db: Database,
  repoId: string,
): MirrorLink | undefined {
  const row = db
    .query<
      {
        origin_id: string | null;
        origin_full_name: string | null;
        origin_remote_id: string | null;
        origin_html_url: string | null;
        clone_url: string | null;
      },
      [string]
    >(
      `SELECT repo.origin_id, repo.origin_full_name, repo.origin_remote_id,
              repo.origin_html_url, origin_repo.clone_url
       FROM repo
       LEFT JOIN origin_repo ON origin_repo.origin_id = repo.origin_id
                            AND origin_repo.remote_id = repo.origin_remote_id
       WHERE repo.id = ?1`,
    )
    .get(repoId);
  if (!row?.origin_id || !row.origin_full_name) return undefined;
  const origin = getOriginById(db, row.origin_id);
  if (!origin) return undefined;
  return {
    origin,
    fullName: row.origin_full_name,
    remoteId: row.origin_remote_id ?? "",
    htmlUrl: row.origin_html_url ?? "",
    cloneUrl: row.clone_url ?? "",
  };
}

/** Attach a freshly created local repo to the origin it mirrors. */
export function linkRepoToOrigin(
  db: Database,
  repoId: string,
  input: {
    originId: string;
    fullName: string;
    remoteId: string;
    htmlUrl: string;
  },
): void {
  db.query(
    `UPDATE repo SET origin_id = ?1, origin_full_name = ?2,
       origin_remote_id = ?3, origin_html_url = ?4,
       origin_detached_at = NULL WHERE id = ?5`,
  ).run(input.originId, input.fullName, input.remoteId, input.htmlUrl, repoId);
}

// ---- detached mirrors ----

/**
 * A mirror whose origin was disconnected: `origin_id` went NULL with the
 * origin row, and the provenance stayed. It is frozen — nothing fetches
 * into it and a push to it is refused (`origins/push-through.ts`) — until
 * an origin on the same host is attached again (#1090).
 */
export interface DetachedMirror extends RepoDetached {
  readonly repoId: string;
  readonly ownerId: string;
  /** The remote's id at the origin, when it was recorded. */
  readonly remoteId: string;
}

/** The lowercase hostname of a URL, or "" when it is not one. */
export function hostOf(url: string): string {
  return URL.parse(url)?.hostname.toLowerCase() ?? "";
}

/**
 * The site a URL names — scheme, host and port — which is what "the same
 * origin" means for a mirror: `git.example:8443` and `git.example` are two
 * servers, and a mirror reattached across them would sync from the wrong
 * one. `hostOf` is for reading; this is for deciding.
 */
export function siteOf(url: string): string {
  return URL.parse(url)?.origin.toLowerCase() ?? "";
}

interface DetachedRow {
  id: string;
  owner_id: string;
  origin_full_name: string;
  origin_remote_id: string | null;
  origin_html_url: string | null;
  origin_detached_at: string | null;
  last_fetch_at: string | null;
}

const DETACHED_SELECT = `
  SELECT id, owner_id, origin_full_name, origin_remote_id, origin_html_url,
         origin_detached_at, last_fetch_at
  FROM repo
  WHERE origin_id IS NULL AND origin_full_name IS NOT NULL
    AND origin_full_name != ''`;

const toDetached = (row: DetachedRow): DetachedMirror => ({
  repoId: row.id,
  ownerId: row.owner_id,
  fullName: row.origin_full_name,
  remoteId: row.origin_remote_id ?? "",
  htmlUrl: row.origin_html_url ?? "",
  detachedAt: row.origin_detached_at,
  frozenSince: row.last_fetch_at,
});

/** This repo as a detached mirror, or undefined when it is not one. */
export function detachedMirror(
  db: Database,
  repoId: string,
): DetachedMirror | undefined {
  const row = db
    .query<DetachedRow, [string]>(`${DETACHED_SELECT} AND id = ?1`)
    .get(repoId);
  return row ? toDetached(row) : undefined;
}

/**
 * Every detached mirror, oldest first — owned by `ownerId`, and remembered
 * on `site` (scheme, host and port), when those are given. The site is read
 * from the remembered page; a mirror whose page was never recorded is kept,
 * because only its git remote can say where it lived and that is the
 * caller's to read.
 */
export function listDetachedMirrors(
  db: Database,
  filter: { site?: string; ownerId?: string } = {},
): DetachedMirror[] {
  const rows =
    filter.ownerId === undefined
      ? db.query<DetachedRow, []>(`${DETACHED_SELECT} ORDER BY id`).all()
      : db
          .query<
            DetachedRow,
            [string]
          >(`${DETACHED_SELECT} AND owner_id = ?1 ORDER BY id`)
          .all(filter.ownerId);
  const site = filter.site?.toLowerCase();
  return rows
    .map(toDetached)
    .filter(
      (m) =>
        site === undefined || m.htmlUrl === "" || siteOf(m.htmlUrl) === site,
    );
}

export function recordFetch(
  db: Database,
  repoId: string,
  outcome: { at: string; error?: string },
): void {
  db.query(
    "UPDATE repo SET last_fetch_at = ?1, fetch_error = ?2 WHERE id = ?3",
  ).run(outcome.at, outcome.error ?? "", repoId);
}

/** Every local repo mirroring this origin, oldest first. */
export function listMirrors(
  db: Database,
  originId: string,
): { repoId: string; fullName: string }[] {
  return db
    .query<{ id: string; origin_full_name: string | null }, [string]>(
      "SELECT id, origin_full_name FROM repo WHERE origin_id = ?1 ORDER BY id",
    )
    .all(originId)
    .filter((r) => r.origin_full_name !== null)
    .map((r) => ({ repoId: r.id, fullName: r.origin_full_name! }));
}

/**
 * The local mirrors hanging off each of a user's origins, in one query: how
 * many, and the oldest, which is the one a surface names for them all.
 */
export function mirrorsByOrigin(
  db: Database,
  userId: string,
): Map<string, { count: number; first: string }> {
  const rows = db
    .query<{ origin_id: string; n: number; first: string }, [string]>(
      `SELECT repo.origin_id, COUNT(*) AS n, MIN(repo.id) AS first FROM repo
       JOIN origin ON origin.id = repo.origin_id
       WHERE origin.user_id = ?1 GROUP BY repo.origin_id`,
    )
    .all(userId);
  return new Map(
    rows.map((r) => [r.origin_id, { count: r.n, first: r.first }]),
  );
}

/**
 * The local repo already mirroring this remote at this origin, by its id
 * there or by its name: either is the same repository to the sync.
 */
export function mirrorOfRemote(
  db: Database,
  originId: string,
  remote: { remoteId: string; fullName: string },
): string | undefined {
  const row = db
    .query<{ id: string }, [string, string, string]>(
      `SELECT id FROM repo WHERE origin_id = ?1
         AND (origin_remote_id = ?2 OR origin_full_name = ?3 COLLATE NOCASE)
       LIMIT 1`,
    )
    .get(originId, remote.remoteId, remote.fullName);
  return row?.id;
}

/**
 * The repo at this origin that forks `upstream`, if the picker's cache knows
 * of one. Matched on the parent the origin itself reported, never on a name
 * we guessed — a fork may be renamed, and `octo/gears` forked into
 * `me/gears-2` is still my fork of it.
 */
export function findOriginFork(
  db: Database,
  originId: string,
  upstream: string,
): OriginRepoRow | undefined {
  const row = db
    .query<
      RawOriginRepo,
      [string, string]
    >(`${REPO_SELECT} WHERE origin_repo.origin_id = ?1 AND origin_repo.fork_of = ?2 COLLATE NOCASE ORDER BY origin_repo.full_name LIMIT 1`)
    .get(originId, upstream);
  return row ? toOriginRepo(row) : undefined;
}

/** Remember that this local mirror mirrors *my fork of* `upstream`. */
export function setRepoForkOf(
  db: Database,
  repoId: string,
  upstream: string,
): void {
  db.query("UPDATE repo SET origin_fork_of = ?1 WHERE id = ?2").run(
    upstream,
    repoId,
  );
}

/** The upstream this mirror's remote is a fork of, as recorded on the row. */
export function repoForkOf(db: Database, repoId: string): string | null {
  const row = db
    .query<
      { origin_fork_of: string | null },
      [string]
    >("SELECT origin_fork_of FROM repo WHERE id = ?1")
    .get(repoId);
  return row?.origin_fork_of ?? null;
}

/** The local mirror of a remote repo at this origin, by `owner/name` there. */
export function mirrorOf(
  db: Database,
  originId: string,
  fullName: string,
): string | undefined {
  const row = db
    .query<
      { id: string },
      [string, string]
    >("SELECT id FROM repo WHERE origin_id = ?1 AND origin_full_name = ?2 COLLATE NOCASE")
    .get(originId, fullName);
  return row?.id;
}
