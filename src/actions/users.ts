/**
 * Account actions: signing up, minting and revoking tokens, and the SSH keys
 * an account authenticates with over the SSH listener.
 */

import type { App } from "../app.ts";
import {
  addKey,
  deleteKey,
  parseAuthorizedKey,
  type UserKey,
} from "../core/keys.ts";
import {
  createToken as mintToken,
  deleteToken as revokeToken,
  type TokenScope,
} from "../core/tokens.ts";
import {
  countUsers,
  createUser,
  type CreateUserError,
  type User,
} from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";

export interface SignUpInput {
  username: string;
  email: string;
  password: string;
}

/** The first account on a fresh forge is the admin — no setup wizard. */
export async function signUp(
  app: App,
  input: SignUpInput,
): Promise<Result<User, CreateUserError>> {
  const isFirst = countUsers(app.db) === 0;
  const created = await createUser(app.db, { ...input, isAdmin: isFirst });
  if (!created.ok) return created;
  app.bus.append({ kind: "user.created", actorId: created.value.id });
  return created;
}

/**
 * Mint a personal access token. Callers decide what credential may mint one
 * (a session or the password, never another token — no privilege
 * bootstrapping); the action only records it. The secret is returned once.
 */
export function createToken(
  app: App,
  actor: User | undefined,
  name: string,
  scope: TokenScope,
): Result<{ id: string; token: string }, "unauthorized"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  return ok(mintToken(app.db, user.value.id, name, scope));
}

export function deleteToken(
  app: App,
  actor: User | undefined,
  tokenId: string,
): Result<void, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  return revokeToken(app.db, user.value.id, tokenId) ? ok() : err("not_found");
}

export type AddSshKeyError = "unauthorized" | "invalid_key" | "key_exists";

/** Register a public key (an `authorized_keys` line) for the actor. */
export function addSshKey(
  app: App,
  actor: User | undefined,
  input: { name: string; key: string },
): Result<UserKey, AddSshKeyError> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const parsed = parseAuthorizedKey(input.key);
  if (!parsed.ok) return parsed;
  const name = input.name.trim() || parsed.value.comment || parsed.value.algo;
  const added = addKey(app.db, user.value.id, name, parsed.value);
  if (!added.ok) return added;
  app.bus.append({
    kind: "user.key_added",
    actorId: user.value.id,
    payload: { fingerprint: added.value.fingerprint, name: added.value.name },
  });
  return added;
}

export function deleteSshKey(
  app: App,
  actor: User | undefined,
  keyId: string,
): Result<void, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const removed = deleteKey(app.db, user.value.id, keyId);
  if (!removed) return err("not_found");
  app.bus.append({
    kind: "user.key_removed",
    actorId: user.value.id,
    payload: { fingerprint: removed.fingerprint, name: removed.name },
  });
  return ok();
}
