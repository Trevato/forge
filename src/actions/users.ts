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
import { setUserSetting } from "../core/settings.ts";
import {
  createToken as mintToken,
  deleteToken as revokeToken,
  type TokenScope,
} from "../core/tokens.ts";
import {
  changePassword as rehash,
  createUser,
  updateProfile as writeProfile,
  verifyPassword,
  type CreateUserError,
  type ProfilePatch,
  type UpdateProfileError,
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
  const created = await createUser(app.db, { ...input, adminIfFirst: true });
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
  const minted = mintToken(app.db, user.value.id, name, scope);
  app.bus.append({
    kind: "token.created",
    actorId: user.value.id,
    payload: { tokenId: minted.id, name, scope },
  });
  return ok(minted);
}

export function deleteToken(
  app: App,
  actor: User | undefined,
  tokenId: string,
): Result<void, "unauthorized" | "not_found"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  if (!revokeToken(app.db, user.value.id, tokenId)) return err("not_found");
  app.bus.append({
    kind: "token.deleted",
    actorId: user.value.id,
    payload: { tokenId },
  });
  return ok();
}

/** Change display name and/or email. */
export function updateProfile(
  app: App,
  actor: User | undefined,
  patch: ProfilePatch,
): Result<User, "unauthorized" | UpdateProfileError> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const updated = writeProfile(app.db, user.value.id, patch);
  if (!updated.ok) return updated;
  const fields = (["displayName", "email", "commitEmail"] as const).filter(
    (k) => patch[k] !== undefined,
  );
  app.bus.append({
    kind: "user.updated",
    actorId: user.value.id,
    payload: { fields },
  });
  return updated;
}

export type ChangePasswordError =
  | "unauthorized"
  | "bad_credentials"
  | "weak_password";

/** Replace the password; the current one must be presented and verified. */
export async function changePassword(
  app: App,
  actor: User | undefined,
  input: { current: string; next: string },
): Promise<Result<void, ChangePasswordError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const verified = await verifyPassword(
    app.db,
    user.value.username,
    input.current,
  );
  if (!verified.ok) return err("bad_credentials");
  const changed = await rehash(app.db, user.value.id, input.next);
  if (!changed.ok) return err(changed.error === "weak_password" ? "weak_password" : "unauthorized");
  app.bus.append({
    kind: "user.updated",
    actorId: user.value.id,
    payload: { fields: ["password"] },
  });
  return ok();
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

/**
 * Record an interface preference (the terminal's theme, today). Authorized
 * like every other mutation, but deliberately eventless: see
 * `core/settings.ts` — nothing outside the surface that wrote it consumes
 * these, and a theme keypress must not enter the webhook outbox.
 */
export function setPreference(
  app: App,
  actor: User | undefined,
  key: string,
  value: string,
): Result<void, "unauthorized"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  setUserSetting(app.db, user.value.id, key, value);
  return ok();
}
