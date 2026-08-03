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
  /** "org" rows own repos and hold teams but can't authenticate. */
  readonly kind: "user" | "org";
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  display_name: string;
  is_admin: number;
  password_hash: string;
  kind: "user" | "org";
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    kind: row.kind,
  };
}

export type CreateUserError =
  | "invalid_username"
  | "username_taken"
  | "email_taken"
  | "weak_password";

export interface CreateUserInput {
  username: string;
  email: string;
  password: string;
  /** @default "" */
  displayName?: string;
  /** @default false */
  isAdmin?: boolean;
}

export async function createUser(
  db: Database,
  input: CreateUserInput,
): Promise<Result<User, CreateUserError>> {
  if (!isSafeName(input.username)) return err("invalid_username");
  if (input.password.length < 10) return err("weak_password");

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
  const hash = await Bun.password.hash(input.password, "argon2id");
  db.query(
    `INSERT INTO user (id, username, email, password_hash, display_name, is_admin)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(
    userId,
    input.username,
    input.email,
    hash,
    input.displayName ?? "",
    input.isAdmin === true ? 1 : 0,
  );
  return ok({
    id: userId,
    username: input.username,
    email: input.email,
    displayName: input.displayName ?? "",
    isAdmin: input.isAdmin === true,
    kind: "user",
  });
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
  // Org rows own repos but never authenticate, whatever their stored hash.
  if (!valid || !row || row.kind === "org") return err("bad_credentials");
  return ok(toUser(row));
}

export function countUsers(db: Database): number {
  const row = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user")
    .get();
  return row?.n ?? 0;
}
