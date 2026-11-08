/**
 * Accounts as the forge's owner sees them: who joined, how and from where,
 * what each holds and has spent, and its standing. Pure data — the actions
 * decide who may look (`actions/accounts.ts`).
 *
 * Standing has three states. Active is the default. Suspended stops every
 * credential and everything the account's repositories would run, and is
 * undone by unsuspending. Removed is final: the credentials and repositories
 * are gone, the email and display name are scrubbed, and the row stays so
 * the name stays taken and what the account said on others' threads keeps
 * its author.
 */

import type { Database } from "bun:sqlite";
import { forgetListings } from "./listings.ts";

export interface AccountRow {
  readonly username: string;
  readonly kind: "user" | "agent";
  readonly displayName: string;
  readonly isAdmin: boolean;
  readonly createdAt: string;
  /** How the account came: "signup", "edge", or null for one older than the record. */
  readonly via: string | null;
  /** The linked sign-in method it came through ("open-platform.sh" for an edge-made account), else null. */
  readonly signsInThrough: string | null;
  /** The address it signed up from, when one was recorded. */
  readonly address: string | null;
  readonly repos: number;
  readonly apps: number;
  /** What crew runs on its repositories have cost, in dollars. */
  readonly spentUsd: number;
  readonly suspendedAt: string | null;
  readonly removedAt: string | null;
  /** Whether the email is proven (\`core/verify.ts\`); agents always are. */
  readonly verified: boolean;
}

/** What the platform edge's sign-in is called to the owner. */
export const EDGE_METHOD = "open-platform.sh";

/** How an account came, in words: its sign-in method, else its origin, else "crew" for an agent, else "". */
export function originOf(a: Pick<AccountRow, "kind" | "via" | "signsInThrough">): string {
  if (a.signsInThrough !== null) return `signs in through ${a.signsInThrough}`;
  return a.via ?? (a.kind === "agent" ? "crew" : "");
}

/** Every person and agent, newest first. Organizations are not accounts. */
export function listAccounts(db: Database): AccountRow[] {
  const rows = db
    .query<
      {
        id: string;
        username: string;
        display_name: string;
        is_admin: number;
        is_agent: number;
        created_at: string;
        suspended_at: string | null;
        removed_at: string | null;
        verified_at: string | null;
        repos: number;
        apps: number;
        spent: number | null;
        payload: string | null;
      },
      []
    >(
      `SELECT u.id, u.username, u.display_name, u.is_admin, u.is_agent,
              u.created_at, u.suspended_at, u.removed_at,
              (SELECT c.verified_at FROM email_check c WHERE c.user_id = u.id) AS verified_at,
              (SELECT COUNT(*) FROM repo r WHERE r.owner_id = u.id) AS repos,
              (SELECT COUNT(*) FROM app a JOIN repo r ON r.id = a.repo_id
                WHERE r.owner_id = u.id) AS apps,
              (SELECT SUM(g.cost_usd) FROM usage g JOIN repo r ON r.id = g.repo_id
                WHERE r.owner_id = u.id) AS spent,
              (SELECT e.payload FROM event e
                WHERE e.kind = 'user.created' AND e.actor_id = u.id
                ORDER BY e.id LIMIT 1) AS payload
       FROM user u WHERE u.kind = 'user'
       ORDER BY u.created_at DESC, u.id DESC`,
    )
    .all();
  return rows.map((r) => {
    const origin = parseOrigin(r.payload);
    return {
      username: r.username,
      kind: r.is_agent === 1 ? "agent" : "user",
      displayName: r.display_name,
      isAdmin: r.is_admin === 1,
      createdAt: r.created_at,
      via: origin.via,
      signsInThrough: origin.via === EDGE_VIA ? EDGE_METHOD : null,
      address: origin.address,
      repos: r.repos,
      apps: r.apps,
      spentUsd: Math.round((r.spent ?? 0) * 100) / 100,
      suspendedAt: r.suspended_at,
      removedAt: r.removed_at,
      verified: r.is_agent === 1 || r.verified_at !== null,
    };
  });
}

/** What `user.created` records as `via` for an account the platform edge made. */
const EDGE_VIA = "edge";

function parseOrigin(payload: string | null): {
  via: string | null;
  address: string | null;
} {
  if (payload === null) return { via: null, address: null };
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    return {
      via: typeof p["via"] === "string" ? p["via"] : null,
      address: typeof p["address"] === "string" ? p["address"] : null,
    };
  } catch {
    return { via: null, address: null };
  }
}

/**
 * Whether the account that owns something is in good standing. An unknown
 * id is not: nothing runs for an owner the forge cannot name.
 */
export function accountActive(db: Database, userId: string): boolean {
  const row = db
    .query<
      { suspended_at: string | null; removed_at: string | null },
      [string]
    >("SELECT suspended_at, removed_at FROM user WHERE id = ?1")
    .get(userId);
  return row !== null && row.suspended_at === null && row.removed_at === null;
}

/** Suspend or restore. Credentials are dropped by the caller on suspend. */
export function setSuspended(
  db: Database,
  userId: string,
  at: string | null,
): void {
  db.query("UPDATE user SET suspended_at = ?1 WHERE id = ?2").run(at, userId);
  forgetListings(db);
}

/** Every way the account could prove it is itself, gone. */
export function dropCredentials(db: Database, userId: string): void {
  db.query("DELETE FROM session WHERE user_id = ?1").run(userId);
  db.query("DELETE FROM token WHERE user_id = ?1").run(userId);
}

/**
 * The account's own traces, scrubbed: keys, settings, memberships and
 * personal details. The row stays, named, so nobody can take the name and
 * others' threads keep their author.
 */
export function scrubAccount(db: Database, userId: string, at: string): void {
  dropCredentials(db, userId);
  // Its keys, settings, memberships, and the other forges it connected
  // (whose credentials live on `origin` and `origin_app`).
  for (const table of [
    "user_key",
    "user_setting",
    "team_member",
    "origin",
    "origin_app",
    "oauth_flow",
    "pin",
  ])
    db.query(`DELETE FROM ${table} WHERE user_id = ?1`).run(userId);
  db.query("DELETE FROM interaction WHERE viewer_id = ?1").run(userId);
  db.query("DELETE FROM share WHERE sender_id = ?1 OR recipient_id = ?1").run(
    userId,
  );
  db.query(
    `UPDATE user SET email = 'removed-' || id || '@forge.invalid',
            display_name = '', password_hash = '',
            suspended_at = COALESCE(suspended_at, ?1), removed_at = ?1
     WHERE id = ?2`,
  ).run(at, userId);
  forgetListings(db);
}

/**
 * People who can sign in only through the platform edge: an account it made
 * or one linked to an edge login, with no password, no passkey and no parent
 * link. Switching `signin.edge` off would strand each of them. Admins first,
 * then oldest, so the longest-waiting is named first.
 */
export function edgeOnlyAccounts(
  db: Database,
): { username: string; isAdmin: boolean; createdAt: string }[] {
  return withoutOwnCredential(db, true);
}

/**
 * Active people with no password, no passkey and no parent link. With
 * `edgeMade` only those the edge made or linked; without, everyone the
 * edge alone could sign in, whatever made the account.
 */
function withoutOwnCredential(
  db: Database,
  edgeMade: boolean,
  userId = "",
): { username: string; isAdmin: boolean; createdAt: string }[] {
  return db
    .query<{ username: string; is_admin: number; created_at: string }, [string, number, string]>(
      `SELECT u.username, u.is_admin, u.created_at FROM user u
       WHERE u.kind = 'user' AND u.is_agent = 0 AND u.removed_at IS NULL
         AND (?3 = '' OR u.id = ?3)
         AND u.password_hash = ''
         AND NOT EXISTS (SELECT 1 FROM passkey p WHERE p.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM federated_identity f WHERE f.user_id = u.id)
         AND (?2 = 0 OR EXISTS (SELECT 1 FROM edge_link l WHERE l.user_id = u.id)
              OR EXISTS (SELECT 1 FROM event e WHERE e.kind = 'user.created'
                         AND e.actor_id = u.id
                         AND CASE WHEN json_valid(e.payload)
                                  THEN json_extract(e.payload, '$.via') END = ?1))
       ORDER BY u.is_admin DESC, u.created_at, u.id`,
    )
    .all(EDGE_VIA, edgeMade ? 1 : 0, userId)
    .map((r) => ({ username: r.username, isAdmin: r.is_admin === 1, createdAt: r.created_at }));
}

/**
 * How far the forge's own sign-in reaches: the people who can sign in
 * without the platform edge and the ones who cannot (everyone `withoutOwnCredential` names).
 */
export function signinReach(db: Database): {
  total: number;
  own: number;
  stranded: { username: string; isAdmin: boolean; createdAt: string }[];
} {
  const total = db
    .query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM user WHERE kind = 'user' AND is_agent = 0 AND removed_at IS NULL",
    )
    .get()?.n ?? 0;
  const stranded = withoutOwnCredential(db, false);
  return { total, own: Math.max(0, total - stranded.length), stranded };
}

/**
 * Whether this person can sign in without the platform edge. The one
 * predicate behind the reach count, the lists and the admin's own refusal.
 */
export function signsInWithoutEdge(db: Database, userId: string): boolean {
  return withoutOwnCredential(db, false, userId).length === 0;
}
