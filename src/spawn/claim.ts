/**
 * The claim link: how a spawned child forge is handed to the person it was
 * made for. The spawner sees the link once; the child keeps only its
 * sha256, a deadline (24 hours) and whether it was used. Whoever opens it
 * first and makes an account becomes the child's admin and an owner of its
 * organisation, and the link is burnt in the same statement that checks it,
 * so two people racing on one link cannot both win.
 *
 * A claim is bound to a spawned forge: it is read only from the
 * organisation `parent.json` names (`spawnedOrg`), so a forge that was not
 * spawned has no claim at all, and a row under any other account is never
 * consulted. A forge that already has an admin cannot be claimed.
 *
 * It lives in `user_setting` on the child's organisation, one row: a
 * single-use secret that a fresh child needs exactly once, with no schema
 * change for every child to replay. Losing the row costs a new link from
 * the spawner, never access.
 */

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { App } from "../app.ts";
import {
  addTeamMember,
  getOrg,
  listTeamMembers,
  listTeams,
  OWNERS_TEAM,
  removeTeamMember,
} from "../core/orgs.ts";
import type { Credential } from "../auth/webauthn.ts";
import { addPasskey } from "../core/passkeys.ts";
import { activeEdgeToken } from "../http/edge.ts";
import { getUserByName, isActive, type User } from "../core/users.ts";
import { sha256 } from "../kernel/hash.ts";

const KEY = "spawn_claim";
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The link a person is sent: the secret rides the fragment, which a
 * browser never sends — not in the request line, not in a Referer — so no
 * server, edge or proxy between them and the child ever logs it.
 */
export const claimLink = (childUrl: string, token: string): string =>
  `${childUrl.replace(/\/+$/, "")}/claim#${token}`;

interface Stored {
  /** sha256 of the token, hex. */
  readonly h: string;
  /** When it stops working, ISO. */
  readonly e: string;
  /** When it was used, ISO; null while it is unused. */
  readonly u: string | null;
  /** When the spawner took it back, ISO; absent while it stands. */
  readonly r?: string;
}

export type ClaimState =
  | { readonly state: "ok"; readonly orgId: string }
  | { readonly state: "used" | "expired" | "revoked" | "unknown" | "owned" };

/** What a spawned child's `parent.json` says, when it has one. */
export interface Spawned {
  readonly org: User;
  /** Whether the spawner keeps owner access after the claim. */
  readonly keepAccess: boolean;
  /** The child's own address, `<name>--<parent's host>`, when recorded. */
  readonly url: string | undefined;
  /** The hash of what the parent answers to (`spawn/clients.ts`), when recorded. */
  readonly statusHash: string | undefined;
}

/** The organisation this forge was spawned as, or undefined if it was not spawned. */
export async function spawnedOrg(app: App): Promise<Spawned | undefined> {
  const file = Bun.file(join(app.config.dataDir, "parent.json"));
  if (!(await file.exists())) return undefined;
  try {
    const parsed = (await file.json()) as {
      org?: unknown;
      keepAccess?: unknown;
      url?: unknown;
      statusHash?: unknown;
    };
    const org =
      typeof parsed.org === "string" ? getOrg(app.db, parsed.org) : undefined;
    return org === undefined
      ? undefined
      : {
          org,
          keepAccess: parsed.keepAccess === true,
          url:
            typeof parsed.url === "string" && /^https?:\/\//.test(parsed.url)
              ? parsed.url
              : undefined,
          statusHash:
            typeof parsed.statusHash === "string" && /^[0-9a-f]{64}$/.test(parsed.statusHash)
              ? parsed.statusHash
              : undefined,
        };
  } catch {
    return undefined;
  }
}

/** 32 random bytes, base64url: the only copy of the secret. */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mint the child's claim link for `orgId`, replacing any earlier one, and
 * return the token. Called by spawn on the child's database.
 */
export function mintClaim(
  db: Database,
  orgId: string,
  now = Date.now(),
): string {
  const token = newToken();
  const value: Stored = {
    h: sha256(token),
    e: new Date(now + CLAIM_TTL_MS).toISOString(),
    u: null,
  };
  db.query(
    `INSERT INTO user_setting (user_id, key, value) VALUES (?1, ?2, ?3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
  ).run(orgId, KEY, JSON.stringify(value));
  return token;
}

/** Whether a person already administers this forge: then it is not claimable. */
export const hasAdmin = (db: Database): boolean =>
  db
    .query(
      "SELECT 1 FROM user WHERE is_admin = 1 AND is_agent = 0 AND kind = 'user' LIMIT 1",
    )
    .get() !== null;

function find(
  db: Database,
  orgId: string,
  token: string,
): { raw: string; stored: Stored } | undefined {
  if (!TOKEN.test(token)) return undefined;
  const row = db
    .query<
      { value: string },
      [string, string]
    >("SELECT value FROM user_setting WHERE user_id = ?1 AND key = ?2")
    .get(orgId, KEY);
  if (!row) return undefined;
  let stored: Stored;
  try {
    stored = JSON.parse(row.value) as Stored;
  } catch {
    return undefined;
  }
  return stored.h === sha256(token) ? { raw: row.value, stored } : undefined;
}

function judge(
  db: Database,
  orgId: string,
  token: string,
  now: number,
): { state: ClaimState; raw?: string; stored?: Stored } {
  const found = find(db, orgId, token);
  if (found === undefined) return { state: { state: "unknown" } };
  if (found.stored.u !== null) return { state: { state: "used" } };
  if (found.stored.r !== undefined) return { state: { state: "revoked" } };
  if (Date.parse(found.stored.e) <= now) return { state: { state: "expired" } };
  if (hasAdmin(db)) return { state: { state: "owned" } };
  return {
    state: { state: "ok", orgId },
    raw: found.raw,
    stored: found.stored,
  };
}

/** What a token is worth right now on the organisation `orgId`, without spending it. */
export function readClaim(
  db: Database,
  orgId: string,
  token: string,
  now = Date.now(),
): ClaimState {
  return judge(db, orgId, token, now).state;
}

/**
 * Spend the token: "ok" for exactly one caller. The row is swapped only if
 * it is still the unused value just read, in one statement.
 */
export function burnClaim(
  db: Database,
  orgId: string,
  token: string,
  now = Date.now(),
): ClaimState {
  const judged = judge(db, orgId, token, now);
  if (
    judged.state.state !== "ok" ||
    judged.raw === undefined ||
    judged.stored === undefined
  )
    return judged.state;
  const spent: Stored = { ...judged.stored, u: new Date(now).toISOString() };
  const swapped = db
    .query(
      "UPDATE user_setting SET value = ?1 WHERE user_id = ?2 AND key = ?3 AND value = ?4",
    )
    .run(JSON.stringify(spent), orgId, KEY, judged.raw);
  return swapped.changes === 1 ? judged.state : { state: "used" };
}

/** Put a spent token back, when the account it was spent on could not be made. */
export function unburnClaim(db: Database, orgId: string, token: string): void {
  const found = find(db, orgId, token);
  if (found === undefined || found.stored.u === null) return;
  const back: Stored = { ...found.stored, u: null };
  db.query(
    "UPDATE user_setting SET value = ?1 WHERE user_id = ?2 AND key = ?3 AND value = ?4",
  ).run(JSON.stringify(back), orgId, KEY, found.raw);
}

/**
 * The spawn-made founder a claim may take over, when the name asked for is
 * its name: the account `copyInto` made under the spawner's own username,
 * so the spawner could never claim their child as themselves. Only while
 * it is untouched — the Owners team's first member, a person, active, with
 * no password, passkey, token, SSH key, session, parent sign-in, edge
 * link or OAuth-client grant — and only when the spawner is
 * leaving (`keepAccess` false): an account the spawner keeps is theirs, not the
 * claimant's to take. Never on a forge with edge sign-in on.
 *
 * Deliberate: whoever holds the claim link becomes the spawner's username
 * on the child (the link is the proof, as for any claim; an admin can
 * rename it after). The claim page says so before anyone submits.
 */
export function founderToTake(
  app: App,
  spawned: Spawned,
  username: string,
): User | undefined {
  if (spawned.keepAccess) return undefined;
  // Where the platform edge signs people in, a name is a login: the
  // spawner's edge sign-in lands on this account, so it is never handed to
  // whoever holds the link.
  if (activeEdgeToken(app) !== undefined) return undefined;
  const db = app.db;
  const user = getUserByName(db, username);
  if (user === undefined || user.kind !== "user" || !isActive(user)) return undefined;
  const team = listTeams(db, spawned.org.id).find((t) => t.name === OWNERS_TEAM);
  const founder = team === undefined ? undefined : listTeamMembers(db, team.id)[0];
  if (founder?.id !== user.id) return undefined;
  return untouched(db, user.id) ? user : undefined;
}

/** No way in of its own: no password, passkey, token, SSH key, session, parent link, edge link, or OAuth-client grant. */
function untouched(db: Database, userId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT count(*) AS n FROM user u WHERE u.id = ?1 AND u.password_hash = '' AND u.is_agent = 0
           AND NOT EXISTS (SELECT 1 FROM passkey WHERE user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM token WHERE user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM user_key WHERE user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM session WHERE user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM federated_identity WHERE user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM edge_link WHERE user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM oauth_refresh WHERE user_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM oauth_code WHERE user_id = ?1)`,
      )
      .get(userId)!.n === 1
  );
}

/**
 * The claimant becomes the founder: its credential (a password hash, or a
 * passkey with an empty hash), its email, and admin, in one transaction
 * that re-checks the account is still untouched and drops any leftover
 * sessions so an old cookie cannot keep acting as the new admin. "gone"
 * when it is not (or the passkey would not go on); "email_taken" when
 * another account holds the address.
 */
export function takeFounder(
  db: Database,
  userId: string,
  input: { readonly hash: string; readonly email: string; readonly credential?: Credential },
): "ok" | "gone" | "email_taken" {
  const take = db.transaction((): boolean => {
    if (!untouched(db, userId)) return false;
    db.query("UPDATE user SET password_hash = ?2, email = ?3, is_admin = 1 WHERE id = ?1").run(
      userId,
      input.hash,
      input.email,
    );
    if (input.credential !== undefined && !addPasskey(db, userId, "Passkey", input.credential).ok)
      throw new PasskeyRefused();
    db.query("DELETE FROM session WHERE user_id = ?1").run(userId);
    return true;
  });
  try {
    return take() ? "ok" : "gone";
  } catch (error) {
    if (error instanceof PasskeyRefused) return "gone";
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return "email_taken";
    throw error;
  }
}

class PasskeyRefused extends Error {}

/**
 * Give a spawned child's organisation to its first admin: they join its
 * Owners and, unless the spawner asked to keep access, the spawner leaves.
 * The claim page and the first-admin code (`core/first_admin.ts`) both end here.
 */
export function handOver(db: Database, spawned: Spawned, userId: string): void {
  const team = listTeams(db, spawned.org.id).find((t) => t.name === OWNERS_TEAM);
  if (team === undefined) return;
  const spawner = listTeamMembers(db, team.id)[0];
  addTeamMember(db, team, userId);
  if (!spawned.keepAccess && spawner && spawner.id !== userId)
    removeTeamMember(db, team, spawner.id);
}

/** How long a revoke can be taken back. */
export const REVOKE_UNDO_MS = 60_000;

/** A link as its sender sees it: open, used, or ended (revoked or past its day). */
export type LinkState = "open" | "used" | "ended";

/** The link's state, and when its sender took it back (ISO) when they did. */
export interface LinkInfo {
  readonly state: LinkState;
  readonly revokedAt: string | null;
  /** When the link was spent (someone opened it and made an account), ISO; absent while unspent. */
  readonly usedAt?: string | null;
  /** When the link stops working, ISO. */
  readonly expiresAt?: string;
}

/** True while an ended link can still be brought back: revoked in the last minute, in date, unspent. */
export const undoable = (link: LinkInfo, now = Date.now()): boolean =>
  link.state === "ended" && link.revokedAt !== null && now - Date.parse(link.revokedAt) <= REVOKE_UNDO_MS;

type Found = { readonly value: string; readonly stored: Stored };

const readStored = (db: Database, orgId?: string): Found | undefined => {
  const row =
    orgId === undefined
      ? db.query<{ value: string }, [string]>("SELECT value FROM user_setting WHERE key = ?1").get(KEY)
      : db.query<{ value: string }, [string, string]>("SELECT value FROM user_setting WHERE user_id = ?2 AND key = ?1").get(KEY, orgId);
  if (!row) return undefined;
  try {
    return { value: row.value, stored: JSON.parse(row.value) as Stored };
  } catch {
    return undefined;
  }
};

const stateOf = (s: Stored, now: number): LinkState =>
  s.u !== null ? "used" : s.r !== undefined || Date.parse(s.e) <= now ? "ended" : "open";

/** The claim link in this forge's own database; null when it has none. */
export function linkOf(db: Database, now = Date.now()): LinkInfo | null {
  const found = readStored(db);
  return found === undefined ? null : { state: stateOf(found.stored, now), revokedAt: found.stored.r ?? null, usedAt: found.stored.u, expiresAt: found.stored.e };
}

/** Replace the stored link only if nobody changed it since it was read. */
function swap(db: Database, orgId: string, from: Found, next: Stored): boolean {
  return (
    db
      .query("UPDATE user_setting SET value = ?1 WHERE user_id = ?2 AND key = ?3 AND value = ?4")
      .run(JSON.stringify(next), orgId, KEY, from.value).changes === 1
  );
}

/** Take back an open link: from now it answers "ended". False when it was not open. */
export function revokeClaim(db: Database, orgId: string, now = Date.now()): boolean {
  const found = readStored(db, orgId);
  if (found === undefined || stateOf(found.stored, now) !== "open") return false;
  return swap(db, orgId, found, { ...found.stored, r: new Date(now).toISOString() });
}

/** Undo a revoke made in the last minute, if the link is still unspent and in date. */
export function restoreClaim(db: Database, orgId: string, now = Date.now()): boolean {
  const found = readStored(db, orgId);
  if (found === undefined) return false;
  const { r, ...back } = found.stored;
  if (r === undefined || back.u !== null || Date.parse(back.e) <= now) return false;
  if (!undoable({ state: "ended", revokedAt: r }, now)) return false;
  return swap(db, orgId, found, back);
}
