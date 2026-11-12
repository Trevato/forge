/**
 * Users — humans and bots alike. A bot is just a user whose credentials are
 * narrower; there is no second identity system.
 */

import { GATE_RETRY_AFTER, withinPasswordCap, withHashSlot } from "./hash-gate.ts";
import { markUnproven, markVerified } from "./verify.ts";
import type { Database } from "bun:sqlite";
import { isSafeName } from "../git/guard.ts";
import { reservedName } from "./reserved.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { admitSignin } from "./signin-window.ts";
import { waitingCount, WAITING_CAP } from "./requests.ts";
import { getSignup, type SignupMode } from "../settings/signup.ts";
import { inviteOpen, redeemInvite, reopenInvite } from "./invites.ts";
import type { SignupSlot } from "../actions/signup-window.ts";

export interface User {
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly displayName: string;
  readonly isAdmin: boolean;
  /**
   * "org" rows own repos and hold teams but can't authenticate. "agent"
   * rows are the crew: no password, no session; they act only through
   * tokens the forge mints for a run (docs/APPS.md).
   */
  readonly kind: "user" | "org" | "agent";
  /**
   * Which address the commits the forge writes for this person carry: the
   * no-reply one on the forge's host, or — by explicit opt-in — `email`
   * (`core/commit_identity.ts`).
   */
  readonly commitEmail: CommitEmail;
  readonly createdAt: string;
  /** When the owner suspended the account; null while it is in good standing. */
  readonly suspendedAt: string | null;
  /** When the owner removed it. The row stays so the name stays taken. */
  readonly removedAt: string | null;
  /**
   * Set while a stranger's request for this account is unanswered, and kept
   * once it is declined; cleared by Allow (`core/requests.ts`). Such an
   * account can do nothing: every credential asks `isActive`.
   */
  readonly waitingAt: string | null;
}

export type CommitEmail = "noreply" | "account";

interface UserRow {
  id: string;
  username: string;
  email: string;
  display_name: string;
  is_admin: number;
  password_hash: string;
  kind: "user" | "org";
  is_agent: number;
  commit_email: CommitEmail;
  created_at: string;
  suspended_at: string | null;
  removed_at: string | null;
  waiting_at: string | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    // The flag, not the column, decides: see migration 14 for why an agent
    // is stored as kind 'user' with is_agent set.
    kind: row.is_agent === 1 ? "agent" : row.kind,
    commitEmail: row.commit_email === "account" ? "account" : "noreply",
    createdAt: row.created_at,
    suspendedAt: row.suspended_at,
    removedAt: row.removed_at,
    waitingAt: row.waiting_at ?? null,
  };
}

/**
 * Whether an account may act at all. Every credential — session, token,
 * password, edge sign-in, SSH key — asks this before it names a person.
 */
export const isActive = (user: User): boolean =>
  user.suspendedAt === null && user.removedAt === null && user.waitingAt === null;

/**
 * Whether `viewer` finds no account at `user`'s name: a suspended or removed
 * person is kept, and hidden from everyone but a site admin (#831). Their
 * name stays on what they wrote in others' threads.
 */
export const hiddenFrom = (user: User, viewer: User | undefined): boolean =>
  user.kind === "user" && !isActive(user) && viewer?.isAdmin !== true;

// The minimum counts characters, the cap (`hash-gate.ts`) counts bytes: the
// hash reads bytes, and a person never meets the difference at these sizes.
export const MIN_PASSWORD = 10;
const MAX_EMAIL = 254;
const MAX_DISPLAY_NAME = 80;

export type CreateUserError =
  | "invalid_username"
  | "username_taken"
  | "username_reserved"
  | "email_taken"
  | "weak_password"
  | "password_too_long"
  | "signup_closed";

/**
 * Where a new account comes from — said by every caller, because this is the
 * one place accounts are made, so the owner's signup setting is held here
 * and not at each door.
 *
 * A stranger's door (the signup form, the API and the terminal through
 * `signUp`, the passkey door, the parent forge's sign-in) is refused while
 * signup is not open and must bring a place it took in the sign-up window.
 * The platform edge is a stranger's door too; it vouches for the login and
 * is held to the setting, not to the window, which it never was.
 *
 * Every other origin is a named exemption, made by someone the forge already
 * trusts: a claim link the owner handed out, an admin's everyday account, a
 * crew member the admin adds, a spawned forge's seed accounts, the account an
 * agent's start call makes (`start`, held by the agent-start setting) and
 * the person who opens that account's claim link (`claimer`), the
 * operator's first admin (`first-admin`, from the one-time code only the
 * operator is shown), and `seed` for code that sets a forge up directly (the
 * chaos world, test fixtures).
 * A new exemption is one more name here.
 *
 * Only an `AdminOrigin` makes a site admin: the claim link a spawned forge's
 * owner hands out (with the Owners handover), the operator's `first-admin`
 * code, and `seed`, which no request reaches. Every other origin makes a person who is not an admin, even on a
 * forge with no admin at all: no sign-up becomes the admin by being first.
 */
export type StrangerOrigin = "signup" | "passkey";
export type AdminOrigin = "claim" | "first-admin" | "seed";
export type ExemptOrigin = AdminOrigin | "everyday" | "agent" | "spawn" | "start" | "claimer";
export type AccountOrigin =
  /**
   * `invite` is the token of an invite link (`core/invites.ts`): while
   * signup is `invite` it opens the door once, spent with the account.
   */
  | {
      origin: "signup" | "passkey";
      slot: SignupSlot;
      invite?: string | undefined;
      /** What they say they want to build, and where the ask came from (`core/requests.ts`). */
      ask?: { note: string; source: string } | undefined;
    }
  | { origin: "edge" }
  | { origin: Exclude<ExemptOrigin, AdminOrigin> }
  | ({ origin: AdminOrigin } & AdminFields);

interface AdminFields {
  /** @default false */
  isAdmin?: boolean;
  /**
   * Make this account the admin if it is the first one — decided inside the
   * INSERT, so two racing first accounts can never both win.
   * @default false
   */
  adminIfFirst?: boolean;
}

export type CreateUserInput = CreateUserFields & AccountOrigin;

/**
 * Whether no stranger may make an account now: signup is not `open`. A fresh
 * forge's first account is held to it too: no sign-up makes the admin (the
 * operator's first-admin link or a claim does), so being first earns nothing.
 * While signup is `invite`, an open invite's token lets one stranger in
 * (`inviteNeeded` says when it must be spent).
 */
export function newAccountsClosed(db: Database, invite?: string): boolean {
  return accountsClosedIn(db, getSignup(db), invite);
}

/**
 * Whether a stranger needs an invite (or cannot come in at all) now. In
 * `request` anyone may ask, and waits unless an open invite vouches for them.
 */
function inviteNeeded(db: Database): boolean {
  const mode = getSignup(db);
  return mode === "invite" || mode === "closed";
}

/** `newAccountsClosed` for a mode the caller has read already, so one request reads the setting once. */
export function accountsClosedIn(db: Database, mode: SignupMode, invite?: string): boolean {
  // In `request` the door shuts once the Waiting list is full, for anyone an open invite does not vouch for.
  if (mode === "request") return waitingCount(db) >= WAITING_CAP && !(invite !== undefined && inviteOpen(db, invite));
  // Open lets anyone in; invite and closed need an invite, and only invite takes one.
  if (mode !== "invite" && mode !== "closed") return false;
  return !(mode === "invite" && invite !== undefined && inviteOpen(db, invite));
}

interface CreateUserFields {
  username: string;
  email: string;
  /**
   * Absent, no password is stored and none ever verifies: the account is
   * signed in by something that vouches for it — the platform edge.
   */
  password?: string;
  /** @default "" */
  displayName?: string;
  /**
   * Create a crew member: no password is stored (`password` is ignored),
   * so nothing can ever sign in as it. Never admin, never first.
   * @default false
   */
  agent?: boolean;
  /**
   * The caller vouches for this account's email: a seeded account (a
   * spawned forge's admin, a claim, a test fixture). Without it the account
   * starts unproven and must follow a link before it can create or cost
   * (\`core/verify.ts\`) — so a way in added later that forgets to say so is
   * held back, never trusted by accident. Agents are never held back.
   * @default false
   */
  trusted?: boolean;
  /**
   * Make the account under a reserved name on purpose (\`core/reserved.ts\`):
   * a seed that names it deliberately. Every other way in — signup, an
   * edge or linked sign-in, any added later — is held to the rule here,
   * in the one place accounts are made. Agents are named by the admin.
   * @default false
   */
  allowReserved?: boolean;
  /**
   * The account naming this one, whose own name does not count against it:
   * an admin's everyday account may carry the admin's handle ("ada-me").
   * Every other protected name still does.
   */
  reservedSelf?: string;
}

/**
 * Undo an account made a moment ago whose sign-up did not finish (its key
 * was refused). Only an account with no password, no repository and no
 * other trace is removed; anything else stays.
 */
export function discardFreshUser(db: Database, userId: string): void {
  // RETURNING counts the account, not the trigger's write to `front_epoch`.
  const removed = db.query("DELETE FROM user WHERE id = ?1 AND password_hash = '' RETURNING id").all(userId);
  if (removed.length === 1) reopenInvite(db, userId);
}

/**
 * What an origin is held to before its account is made: refused, or let in,
 * with the invite token to spend in the same write as the account when an
 * invite is what let it in.
 */
type Admission =
  | { readonly admitted: false }
  | { readonly admitted: true; readonly spend: string | undefined; readonly request: "waiting" | "none" };

const ADMITTED: Admission = { admitted: true, spend: undefined, request: "none" };
const REFUSED: Admission = { admitted: false };

function admission(db: Database, input: AccountOrigin): Admission {
  switch (input.origin) {
    case "signup":
    case "passkey":
      if (input.slot.spent) throw new Error("a sign-up slot makes one account");
      if (getSignup(db) === "request") {
        // An open invite vouches for its holder; anyone else waits to be allowed.
        if (input.invite !== undefined && inviteOpen(db, input.invite))
          return { admitted: true, spend: input.invite, request: "none" };
        return waitingCount(db) >= WAITING_CAP ? REFUSED : { admitted: true, spend: undefined, request: "waiting" };
      }
      if (!inviteNeeded(db)) return ADMITTED;
      return newAccountsClosed(db, input.invite) || input.invite === undefined
        ? REFUSED
        : { admitted: true, spend: input.invite, request: "none" };
    case "edge":
      return newAccountsClosed(db) ? REFUSED : ADMITTED;
    case "claim":
    case "everyday":
    case "agent":
    case "spawn":
    case "start":
    case "claimer":
    case "first-admin":
    case "seed":
      return ADMITTED;
    default: {
      // A new origin is a decision: tsc refuses one left out above.
      const unclassified: never = input;
      return unclassified;
    }
  }
}

/** The admin flags an origin may carry: none but an `AdminOrigin`'s. */
function adminOf(input: AccountOrigin): { isAdmin: boolean; adminIfFirst: boolean } {
  switch (input.origin) {
    case "claim":
    case "first-admin":
    case "seed":
      return { isAdmin: input.isAdmin === true, adminIfFirst: input.adminIfFirst === true };
    default:
      return { isAdmin: false, adminIfFirst: false };
  }
}

export async function createUser(
  db: Database,
  input: CreateUserInput,
): Promise<Result<User, CreateUserError>> {
  const admitted = admission(db, input);
  if (!admitted.admitted) return err("signup_closed");
  const admin = adminOf(input);
  if (!isSafeName(input.username)) return err("invalid_username");
  const agent = input.agent === true;
  const password = agent ? undefined : input.password;
  if (password !== undefined && password.length < MIN_PASSWORD)
    return err("weak_password");
  if (password !== undefined && !withinPasswordCap(password))
    return err("password_too_long");

  const existing = db
    .query<
      { username: string; email: string },
      [string, string]
    >("SELECT username, email FROM user WHERE username = ?1 OR email = ?2")
    .get(input.username, input.email);
  if (existing) {
    return err(
      existing.username.toLowerCase() === input.username.toLowerCase()
        ? "username_taken"
        : "email_taken",
    );
  }
  // Taken is said first; only a name nobody holds can be a reserved one.
  if (
    !agent &&
    input.allowReserved !== true &&
    reservedName(db, input.username, input.reservedSelf) !== undefined
  )
    return err("username_reserved");

  // One account per slot: spent here, with nothing awaited since it was checked.
  if ("slot" in input) input.slot.spend();
  const userId = id();
  // An account without a password has an empty hash, which no verifier
  // accepts: argon2 refuses to parse it (and checkPassword refuses an agent
  // besides).
  const hash =
    password === undefined ? "" : await Bun.password.hash(password, "argon2id");
  // The hash above yielded the event loop, so another sign-up may have landed
  // meanwhile. Uniqueness is settled by the constraint, and "first user" by a
  // subquery in the same statement — neither is a check-then-act.
  // The invite is spent in the same transaction as the account: a taken
  // name gives it back, and of two sign-ups racing for one link one wins.
  const invite = admitted.spend;
  const insert = db.transaction((): boolean => {
    if (invite !== undefined && !redeemInvite(db, invite, userId)) return false;
    db.query(
      `INSERT INTO user (id, username, email, password_hash, display_name, is_admin, is_agent)
       VALUES (?1, ?2, ?3, ?4, ?5,
         CASE WHEN ?8 = 1 THEN 0
              WHEN ?6 = 1 THEN 1
              WHEN ?7 = 1 AND (SELECT COUNT(*) FROM user) = 0 THEN 1
              ELSE 0 END,
         ?8)`,
    ).run(
      userId,
      input.username,
      input.email,
      hash,
      input.displayName ?? "",
      admin.isAdmin ? 1 : 0,
      admin.adminIfFirst ? 1 : 0,
      agent ? 1 : 0,
    );
    // A stranger's account keeps its ask, in the same write, waiting until allowed.
    if (admitted.request === "waiting") {
      const at = new Date().toISOString();
      const ask = "ask" in input ? input.ask : undefined;
      db.query("UPDATE user SET waiting_at = ?1 WHERE id = ?2").run(at, userId);
      db.query(
        "INSERT INTO account_request (user_id, note, source, state, asked_at) VALUES (?1, ?2, ?3, 'waiting', ?4)",
      ).run(userId, ask?.note ?? "", ask?.source ?? "", at);
    }
    return true;
  });
  try {
    if (!insert()) return err("signup_closed");
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const taken = db
      .query<
        { username: string },
        [string]
      >("SELECT username FROM user WHERE username = ?1")
      .get(input.username);
    return err(taken ? "username_taken" : "email_taken");
  }
  // Every person gets a row: proven when the caller vouches, else not yet.
  if (!agent) {
    if (input.trusted === true) markVerified(db, userId, new Date().toISOString());
    else markUnproven(db, userId);
  }
  return ok(getUserById(db, userId)!);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed/.test(error.message)
  );
}

export interface ProfilePatch {
  displayName?: string;
  email?: string;
  commitEmail?: CommitEmail;
}

/**
 * A display name as it is stored: trimmed, cut to its limit, and trimmed
 * again — so a name padded past the cut is judged by what is kept.
 */
export function cleanDisplayName(raw: string): string {
  return raw.trim().slice(0, MAX_DISPLAY_NAME).trim();
}

export type UpdateProfileError =
  | "email_taken"
  | "invalid_email"
  | "invalid_commit_email"
  | "no_such_user";

/** Whether an address is a stand-in (`.invalid`): no mail reaches it, no person gave it. */
export const isStandInEmail = (email: string): boolean => /\.invalid$/i.test(email.trim());

/** Change the mutable profile fields. Absent keys are left untouched. */
export function updateProfile(
  db: Database,
  userId: string,
  patch: ProfilePatch,
): Result<User, UpdateProfileError> {
  const current = getUserById(db, userId);
  if (!current || current.kind === "org") return err("no_such_user");
  let email = patch.email?.trim() ?? current.email;
  // The form shows a stand-in as empty; leaving it so keeps it.
  if (email === "" && isStandInEmail(current.email)) email = current.email;
  if (email === "" || email.length > MAX_EMAIL || !email.includes("@"))
    return err("invalid_email");
  if (email.toLowerCase() !== current.email.toLowerCase()) {
    // Stand-ins belong to the accounts that gave no address; nobody may take one.
    if (isStandInEmail(email)) return err("invalid_email");
    const taken = db
      .query("SELECT 1 FROM user WHERE email = ?1 COLLATE NOCASE AND id != ?2")
      .get(email, userId);
    if (taken) return err("email_taken");
  }
  const displayName = cleanDisplayName(patch.displayName ?? current.displayName);
  const commitEmail = patch.commitEmail ?? current.commitEmail;
  if (commitEmail !== "noreply" && commitEmail !== "account")
    return err("invalid_commit_email");
  db.query(
    "UPDATE user SET email = ?1, display_name = ?2, commit_email = ?3 WHERE id = ?4",
  ).run(email, displayName, commitEmail, userId);
  return ok(getUserById(db, userId)!);
}

/** Replace the password. The caller has already verified the current one. */
export async function changePassword(
  db: Database,
  userId: string,
  next: string,
): Promise<Result<void, "weak_password" | "password_too_long" | "no_such_user">> {
  if (next.length < MIN_PASSWORD) return err("weak_password");
  if (!withinPasswordCap(next)) return err("password_too_long");
  const hash = await Bun.password.hash(next, "argon2id");
  const changed = db
    .query("UPDATE user SET password_hash = ?1 WHERE id = ?2 AND kind = 'user'")
    .run(hash, userId).changes;
  return changed > 0 ? ok() : err("no_such_user");
}

export function getUserById(db: Database, userId: string): User | undefined {
  const row = db
    .query<UserRow, [string]>("SELECT * FROM user WHERE id = ?1")
    .get(userId);
  return row ? toUser(row) : undefined;
}

export function getUserByName(
  db: Database,
  username: string,
): User | undefined {
  const row = db
    .query<
      UserRow,
      [string]
    >("SELECT * FROM user WHERE username = ?1 COLLATE NOCASE")
    .get(username);
  return row ? toUser(row) : undefined;
}

/**
 * The person behind an identity the platform edge vouched for: found by
 * its link first, then by name, never made. The edge vouches for a login, not for a right to an
 * account here, so an unknown login is signed out and goes to /signup, where
 * the `signup` setting decides. Accounts the edge made before still sign in.
 * A name that is an organization or a crew member here is nobody's login.
 */
export function ensureEdgeUser(db: Database, login: string): User | undefined {
  const link = db
    .query<{ user_id: string }, [string]>("SELECT user_id FROM edge_link WHERE login = ?")
    .get(login);
  const existing = (link === null ? undefined : getUserById(db, link.user_id)) ?? getUserByName(db, login);
  return existing && existing.kind === "user" && isActive(existing)
    ? existing
    : undefined;
}

/** Why a password was not accepted: wrong, or tried too often to check. */
export type PasswordRefusal =
  | { readonly reason: "bad_credentials" }
  | { readonly reason: "throttled"; readonly retryAfter: number }
  /** The password is right, and a request for the account still has no yes (\`core/requests.ts\`): no credential. */
  | { readonly reason: "waiting"; readonly username: string };

/** One password attempt: who it names, the secret, and the peer that sent it. */
export interface PasswordAttempt {
  readonly username: string;
  readonly password: string;
  /** The socket's peer (`http/peer.ts` `clientAddress`, or the SSH peer). */
  readonly source: string;
}

/**
 * The only way to prove a password. The attempt is counted in the sign-in
 * windows (per account, per source, per forge: `core/signin-window.ts`)
 * before the hash, so no door can guess at line speed or spend the CPU on
 * argon2; a right password is given back, so a git client that sends it on
 * every request is not throttled. The check itself is not exported: a new door cannot skip the
 * windows, because there is nothing else to call.
 */
export async function verifyPasswordThrottled(
  db: Database,
  attempt: PasswordAttempt,
): Promise<Result<User, PasswordRefusal>> {
  if (!withinPasswordCap(attempt.password))
    return err({ reason: "bad_credentials" });
  const admission = admitSignin(db, attempt.username, attempt.source);
  if (!admission.admitted)
    return err({ reason: "throttled", retryAfter: admission.retryAfter });
  const checked = await withHashSlot(() =>
    checkPassword(db, attempt.username, attempt.password),
  );
  if (checked === undefined) {
    // Never hashed, so it is not a guess: give it back and ask for a moment.
    admission.succeeded();
    return err({ reason: "throttled", retryAfter: GATE_RETRY_AFTER });
  }
  if (!checked.ok && checked.error === "waiting") {
    admission.succeeded();
    return err({ reason: "waiting", username: attempt.username });
  }
  if (!checked.ok) return err({ reason: "bad_credentials" });
  admission.succeeded();
  return checked;
}

/**
 * Whether some password could verify for this account: what `checkPassword`
 * would ever accept. An empty hash never parses, and an org or agent never
 * signs in with one whatever is stored.
 */
export function hasPassword(db: Database, userId: string): boolean {
  return (
    db
      .query("SELECT 1 FROM user WHERE id = ?1 AND password_hash <> '' AND kind <> 'org' AND is_agent = 0")
      .get(userId) !== null
  );
}

/** Constant-shape verification: always burns an argon2 verify, hit or miss. */
async function checkPassword(
  db: Database,
  username: string,
  password: string,
): Promise<Result<User, "bad_credentials" | "waiting">> {
  const row = db
    .query<
      UserRow,
      [string]
    >("SELECT * FROM user WHERE username = ?1 COLLATE NOCASE")
    .get(username);
  // A decoy hash keeps timing identical whether or not the user exists.
  const hash =
    row?.password_hash ??
    "$argon2id$v=19$m=65536,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const valid = await Bun.password.verify(password, hash).catch(() => false);
  // Org rows own repos but never authenticate, whatever their stored hash;
  // neither does an agent, whose hash is empty besides.
  if (!valid || !row || row.kind === "org" || row.is_agent === 1)
    return err("bad_credentials");
  const user = toUser(row);
  // Only the one who knows the password is told their request waits; no credential comes of it.
  if (user.waitingAt !== null && user.suspendedAt === null && user.removedAt === null) return err("waiting");
  return isActive(user) ? ok(user) : err("bad_credentials");
}

/**
 * People — accounts that are neither orgs nor agents — by name, bounded,
 * optionally narrowed by a substring. What an assignee picker offers before
 * the crew; the caller still filters by `canRead` on the repository, since
 * being an account is not being able to see it.
 */
export function listPeople(
  db: Database,
  options: { query?: string | undefined; limit?: number | undefined } = {},
): User[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = options.query?.trim() ?? "";
  const params: (string | number)[] = [];
  let where = "kind = 'user' AND is_agent = 0";
  if (query !== "") {
    params.push(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where += ` AND username LIKE ?${params.length} ESCAPE '\\' COLLATE NOCASE`;
  }
  params.push(limit);
  return db
    .query<UserRow, (string | number)[]>(
      `SELECT * FROM user WHERE ${where} ORDER BY username COLLATE NOCASE LIMIT ?${params.length}`,
    )
    .all(...params)
    .map(toUser);
}

export function countUsers(db: Database): number {
  const row = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user")
    .get();
  return row?.n ?? 0;
}

/**
 * Is this a fresh forge? Every caller of `countUsers` so far only wanted to
 * know whether the number was zero, and `COUNT(*)` answers that by walking
 * the whole table — on the sign-in screen, which every session paints. This
 * stops at the first row.
 */
export function hasAnyUser(db: Database): boolean {
  return db.query("SELECT 1 FROM user LIMIT 1").get() !== null;
}

/**
 * Several accounts by id, in one query. An activity feed names an actor per
 * row; asked one at a time that is a query per row for a list of forty.
 */
export function getUsersByIds(
  db: Database,
  userIds: readonly string[],
): Map<string, User> {
  const out = new Map<string, User>();
  const unique = [...new Set(userIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<
        UserRow,
        string[]
      >(`SELECT * FROM user WHERE id IN (${batch.map((_, n) => `?${n + 1}`).join(",")})`)
      .all(...batch);
    for (const row of rows) out.set(row.id, toUser(row));
  }
  return out;
}
