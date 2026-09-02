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
                         auth_kind, refresh_token_enc, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
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
  db.query(
    `UPDATE origin SET token_enc = ?1,
       refresh_token_enc = CASE WHEN ?2 = '' THEN refresh_token_enc ELSE ?2 END,
       expires_at = ?3, needs_reauth = 0, last_error = ''
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
  /** The local repo mirroring this one, when there is one. */
  readonly mirroredAs: string | null;
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
  mirroredAs: row.mirrored_id,
});

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
    const upsert = db.query(
      `INSERT INTO origin_repo
         (origin_id, remote_id, full_name, description, private, fork,
          default_branch, clone_url, html_url, pushed_at, can_push, seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
         seen_at = excluded.seen_at`,
    );
    for (const repo of repos) {
      if (repo.remoteId === "" || repo.fullName === "") continue;
      upsert.run(
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
      );
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
  db.query(
    `INSERT INTO origin_repo
       (origin_id, remote_id, full_name, description, private, fork,
        default_branch, clone_url, html_url, pushed_at, can_push, seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
       seen_at = excluded.seen_at`,
  ).run(
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
    new Date().toISOString(),
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
       origin_remote_id = ?3, origin_html_url = ?4 WHERE id = ?5`,
  ).run(input.originId, input.fullName, input.remoteId, input.htmlUrl, repoId);
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
