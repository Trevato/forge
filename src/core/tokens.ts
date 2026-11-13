/**
 * Personal access tokens — the credential for git-over-HTTP and the API.
 * The secret is shown once at creation; the database holds only its hash.
 * Scopes are deliberately coarse in v1: ro < rw < admin.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id, secret } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { Proposal } from "./proposal_token.ts";
import { contribNamespace, type ContributeScope } from "./contribute_token.ts";
import type { RunScope } from "./run_token.ts";
import { getUserById, isActive, type User } from "./users.ts";

export type TokenScope = "ro" | "rw" | "admin";

/** What a non-admin is told when they ask for a token that acts as admin. */
export const ADMIN_TOKEN_WORDS = "Only an admin can make a token with admin scope; ro and rw are open to you.";

const rank: Record<TokenScope, number> = { ro: 0, rw: 1, admin: 2 };

export function scopeAllows(held: TokenScope, needed: TokenScope): boolean {
  return rank[held] >= rank[needed];
}

export interface TokenInfo {
  readonly id: string;
  readonly name: string;
  readonly scope: TokenScope;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  /** When the token stops working, or null for a token that does not. */
  readonly expiresAt: string | null;
}

/**
 * Returns the secret exactly once. It is never reconstructable. A token with
 * `expiresAt` is refused after that instant and swept away afterwards — the
 * credential an agent run gets, which must not outlive the run.
 */
export function createToken(
  db: Database,
  userId: string,
  name: string,
  scope: TokenScope,
  options: { expiresAt?: string } = {},
): { id: string; token: string } {
  const tokenId = id();
  const token = `forge_${secret()}`;
  db.query(
    "INSERT INTO token (id, token_hash, user_id, name, scope, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(tokenId, sha256(token), userId, name, scope, options.expiresAt ?? null);
  return { id: tokenId, token };
}

/**
 * How stale `last_used_at` is allowed to get.
 *
 * Recording it on every request turns every *read* into a write: an agent
 * fleet polling the API commits one transaction per request for a timestamp
 * whose only reader is a human glancing at a settings page. At two hundred
 * agents that is the busiest write in the forge, and it is bookkeeping.
 *
 * A minute of resolution answers the only question anyone asks of this field
 * — "is this token still in use?" — and turns those writes into one per
 * token per minute.
 */
const TOUCH_EVERY_MS = 60_000;

export function verifyToken(
  db: Database,
  presented: string,
): Result<
  { user: User; scope: TokenScope; name: string; proposal?: Proposal; run?: RunScope; via?: string; contribute?: ContributeScope },
  "invalid_token"
> {
  const row = db
    .query<
      {
        id: string;
        user_id: string;
        name: string;
        scope: TokenScope;
        last_used_at: string | null;
        expires_at: string | null;
        p_repo: string | null;
        p_child: string | null;
        p_origin: string | null;
        r_repo: string | null;
        r_fork: string | null;
        v_via: string | null;
        c_repo: string | null;
        c_agent: string | null;
      },
      [string]
    >(
      `SELECT t.id, t.user_id, t.name, t.scope, t.last_used_at, t.expires_at,
              p.repo_id AS p_repo, p.child AS p_child, p.origin AS p_origin,
              r.repo_id AS r_repo, r.fork_id AS r_fork, v.via AS v_via,
              c.repo_id AS c_repo, c.agent AS c_agent
         FROM token t LEFT JOIN proposal_token p ON p.token_id = t.id
                      LEFT JOIN run_token r ON r.token_id = t.id
                      LEFT JOIN via_token v ON v.token_id = t.id
                      LEFT JOIN contribute_token c ON c.token_id = t.id
        WHERE t.token_hash = ?1`,
    )
    .get(sha256(presented));
  if (!row) return err("invalid_token");
  // Expiry is decided here, on every use, not by the sweep: a sweep that
  // runs late must not be a token that works late.
  if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now())
    return err("invalid_token");
  const user = getUserById(db, row.user_id);
  if (!user || !isActive(user)) return err("invalid_token");
  const now = Date.now();
  const seen =
    row.last_used_at === null ? 0 : Date.parse(row.last_used_at) || 0;
  if (now - seen >= TOUCH_EVERY_MS) {
    db.query("UPDATE token SET last_used_at = ?1 WHERE id = ?2").run(
      new Date(now).toISOString(),
      row.id,
    );
  }
  // A token with a proposal row is limited to it; the gate in
  // `http/proposal_gate.ts` reads this on every request it makes.
  if (row.p_repo !== null)
    return ok({
      user,
      name: row.name,
      scope: row.scope,
      proposal: {
        tokenId: row.id,
        repoId: row.p_repo,
        child: row.p_child!,
        origin: row.p_origin!,
      },
    });
  // A run's token is bound to its repository (`http/run_gate.ts`).
  if (row.r_repo !== null)
    return ok({
      user,
      name: row.name,
      scope: row.scope,
      run: { repoId: row.r_repo, forkId: row.r_fork! },
    });
  // An outside agent's token is bound to one repository (`http/contribute_gate.ts`).
  if (row.c_repo !== null)
    return ok({
      user,
      name: row.name,
      scope: row.scope,
      contribute: {
        tokenId: row.id,
        repoId: row.c_repo,
        agent: row.c_agent!,
        namespace: contribNamespace(row.c_agent!, row.id),
      },
    });
  // The forge's own agent, speaking for this person (`core/via_token.ts`).
  if (row.v_via !== null) return ok({ user, name: row.name, scope: row.scope, via: row.v_via });
  return ok({ user, name: row.name, scope: row.scope });
}

export function listTokens(db: Database, userId: string): TokenInfo[] {
  const rows = db
    .query<
      {
        id: string;
        name: string;
        scope: TokenScope;
        created_at: string;
        last_used_at: string | null;
        expires_at: string | null;
      },
      [string]
    >(
      "SELECT id, name, scope, created_at, last_used_at, expires_at FROM token WHERE user_id = ?1 ORDER BY id",
    )
    .all(userId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }));
}

/** Remove tokens past their expiry. A cheap DELETE, run on the worker tick. */
export function pruneTokens(db: Database, now: Date = new Date()): number {
  return db
    .query(
      "DELETE FROM token WHERE expires_at IS NOT NULL AND expires_at <= ?1",
    )
    .run(now.toISOString()).changes;
}

export function deleteToken(
  db: Database,
  userId: string,
  tokenId: string,
): boolean {
  return deleteWithRefreshFamily(db, tokenId, userId);
}

/**
 * Remove one token by its id, whoever holds it. For credentials the forge
 * minted on someone's behalf (an app's, a run's) and so revokes itself;
 * a person revoking their own goes through `deleteToken`.
 */
export function revokeToken(db: Database, tokenId: string): boolean {
  return deleteWithRefreshFamily(db, tokenId, null);
}

/**
 * Delete a token and, when the OAuth endpoint minted it with a refresh
 * token, every `oauth_refresh` row of its family, so a revoked harness
 * cannot refresh its way back (#8428). The family is read before the
 * delete: `token_id` clears with the token. Plain SQL, so this module
 * stays free of an import of oauth.ts. Expiry (`pruneTokens`) does not
 * come through here: an expired access token still refreshes.
 */
function deleteWithRefreshFamily(
  db: Database,
  tokenId: string,
  userId: string | null,
): boolean {
  return db.transaction(() => {
    const family = db
      .query<{ family: string }, [string]>(
        "SELECT family FROM oauth_refresh WHERE token_id = ?1 LIMIT 1",
      )
      .get(tokenId);
    const deleted =
      userId === null
        ? db.query("DELETE FROM token WHERE id = ?1").run(tokenId)
        : db
            .query("DELETE FROM token WHERE id = ?1 AND user_id = ?2")
            .run(tokenId, userId);
    if (deleted.changes === 0) return false;
    if (family !== null) {
      db.query("DELETE FROM oauth_refresh WHERE family = ?1").run(family.family);
    }
    return true;
  })();
}

/**
 * Move an expiring token's expiry. A credential held by something that
 * lives as long as it is wanted — a running app — is kept short and
 * renewed while it is, so a forge that dies without revoking it leaves a
 * token that stops working on its own. A token with no expiry is left be.
 */
export function renewToken(
  db: Database,
  tokenId: string,
  expiresAt: string,
): boolean {
  return (
    db
      .query(
        "UPDATE token SET expires_at = ?1 WHERE id = ?2 AND expires_at IS NOT NULL",
      )
      .run(expiresAt, tokenId).changes > 0
  );
}
