/**
 * Users — humans and bots alike. A bot is just a user whose credentials are
 * narrower; there is no second identity system.
 */

import type { Database } from "bun:sqlite";
import { isSafeName } from "../git/guard.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

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
  readonly createdAt: string;
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  display_name: string;
  is_admin: number;
  password_hash: string;
  kind: "user" | "org";
  is_agent: number;
  created_at: string;
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
    createdAt: row.created_at,
  };
}

const MIN_PASSWORD = 10;
const MAX_EMAIL = 254;
const MAX_DISPLAY_NAME = 80;

export type CreateUserError =
  | "invalid_username"
  | "username_taken"
  | "email_taken"
  | "weak_password";

export interface CreateUserInput {
  username: string;
  email: string;
  /**
   * Absent, no password is stored and none ever verifies: the account is
   * signed in by something that vouches for it — the platform edge.
   */
  password?: string;
  /** @default "" */
  displayName?: string;
  /** @default false */
  isAdmin?: boolean;
  /**
   * Make this account the admin if it is the first one — decided inside the
   * INSERT, so two racing first sign-ups can never both win.
   * @default false
   */
  adminIfFirst?: boolean;
  /**
   * Create a crew member: no password is stored (`password` is ignored),
   * so nothing can ever sign in as it. Never admin, never first.
   * @default false
   */
  agent?: boolean;
}

export async function createUser(
  db: Database,
  input: CreateUserInput,
): Promise<Result<User, CreateUserError>> {
  if (!isSafeName(input.username)) return err("invalid_username");
  const agent = input.agent === true;
  const password = agent ? undefined : input.password;
  if (password !== undefined && password.length < MIN_PASSWORD)
    return err("weak_password");

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

  const userId = id();
  // An account without a password has an empty hash, which no verifier
  // accepts: argon2 refuses to parse it (and verifyPassword refuses an agent
  // besides).
  const hash =
    password === undefined ? "" : await Bun.password.hash(password, "argon2id");
  // The hash above yielded the event loop, so another sign-up may have landed
  // meanwhile. Uniqueness is settled by the constraint, and "first user" by a
  // subquery in the same statement — neither is a check-then-act.
  try {
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
      input.isAdmin === true ? 1 : 0,
      input.adminIfFirst === true ? 1 : 0,
      agent ? 1 : 0,
    );
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
}

export type UpdateProfileError =
  | "email_taken"
  | "invalid_email"
  | "no_such_user";

/** Change the mutable profile fields. Absent keys are left untouched. */
export function updateProfile(
  db: Database,
  userId: string,
  patch: ProfilePatch,
): Result<User, UpdateProfileError> {
  const current = getUserById(db, userId);
  if (!current || current.kind === "org") return err("no_such_user");
  const email = patch.email?.trim() ?? current.email;
  if (email === "" || email.length > MAX_EMAIL || !email.includes("@"))
    return err("invalid_email");
  if (email.toLowerCase() !== current.email.toLowerCase()) {
    const taken = db
      .query("SELECT 1 FROM user WHERE email = ?1 COLLATE NOCASE AND id != ?2")
      .get(email, userId);
    if (taken) return err("email_taken");
  }
  const displayName = (patch.displayName ?? current.displayName)
    .trim()
    .slice(0, MAX_DISPLAY_NAME);
  db.query("UPDATE user SET email = ?1, display_name = ?2 WHERE id = ?3").run(
    email,
    displayName,
    userId,
  );
  return ok(getUserById(db, userId)!);
}

/** Replace the password. The caller has already verified the current one. */
export async function changePassword(
  db: Database,
  userId: string,
  next: string,
): Promise<Result<void, "weak_password" | "no_such_user">> {
  if (next.length < MIN_PASSWORD) return err("weak_password");
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
 * name, or made on first sight — with no password, because the edge is how
 * they sign in, and a noreply address until they set one. The first account
 * on a fresh forge is the admin, exactly as at sign-up. A name that is an
 * organization or a crew member here is nobody's login.
 */
export async function ensureEdgeUser(
  db: Database,
  login: string,
  host: string,
): Promise<User | undefined> {
  const existing = getUserByName(db, login);
  if (existing) return existing.kind === "user" ? existing : undefined;
  const made = await createUser(db, {
    username: login,
    email: `${login}@users.noreply.${host}`,
    adminIfFirst: true,
  });
  return made.ok ? made.value : undefined;
}

/** Constant-shape verification: always burns an argon2 verify, hit or miss. */
export async function verifyPassword(
  db: Database,
  username: string,
  password: string,
): Promise<Result<User, "bad_credentials">> {
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
  return ok(toUser(row));
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
