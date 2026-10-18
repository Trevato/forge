/**
 * Account actions: signing up, minting and revoking tokens, and the SSH keys
 * an account authenticates with over the SSH listener.
 */

import { emailChanged, welcome } from "./verify.ts";
import type { App } from "../app.ts";
import type { Credential } from "../auth/webauthn.ts";
import { addPasskey, findPasskey } from "../core/passkeys.ts";
import {
  addKey,
  deleteKey,
  parseAuthorizedKey,
  type UserKey,
} from "../core/keys.ts";
import { turnstileVerifier } from "../core/turnstile.ts";
import { reservedName } from "../core/reserved.ts";
import { setUserSetting } from "../core/settings.ts";
import {
  createToken as mintToken,
  deleteToken as revokeToken,
  type TokenScope,
} from "../core/tokens.ts";
import {
  changePassword as rehash,
  cleanDisplayName,
  createUser,
  discardFreshUser,
  newAccountsClosed,
  updateProfile as writeProfile,
  verifyPassword,
  type CreateUserError,
  type ProfilePatch,
  type UpdateProfileError,
  type User,
} from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";
import type { SignupSlot } from "./signup-window.ts";

export interface SignUpInput {
  username: string;
  email: string;
  password: string;
  /** The Turnstile token the browser's widget gave; read only when a secret is set. */
  humanToken?: string;
}

export type SignUpError =
  | CreateUserError
  | "human_check"
  | "passkey_required"
  | "signup_closed";

/** What anyone is told when the forge makes no new accounts. */
export const SIGNUP_CLOSED_MESSAGE = "Signup is closed on this forge.";

/**
 * Whether no new account may be made now. Read from the store on every call,
 * so a change takes effect on the next request. `invite` acts as closed until
 * invitations exist (#1143). The forge's first account is no exception.
 */
export function signupClosed(app: App): boolean {
  return newAccountsClosed(app.db);
}

/** What anyone is told at a door that still offers a password-only sign-up. */
export const PASSKEY_REQUIRED_MESSAGE =
  "New accounts sign up with a passkey and an email address. Open the sign-up page in a browser and choose \u201cCreate account with a passkey\u201d.";

/** A plausible address: one @, no spaces. The link sent to it is the proof. */
export function plausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** What a person is told when the check fails. */
export const HUMAN_CHECK_MESSAGE =
  "We could not tell you are a person. Reload the page and try again.";

/**
 * A person signs up; never the admin, even the forge's first account
 * (`createUser` decides: the admin comes from the operator or a claim). A
 * name the crew, the owner or the forge itself answers to is not free
 * (`core/reserved.ts`).
 */
export async function signUp(
  app: App,
  input: SignUpInput,
  /** Where the request came from, for the owner's audit of who joined. */
  from: {
    /** The place the door took in the sign-up window (`actions/signup-window.ts`). */
    slot: SignupSlot;
    address?: string | undefined;
  },
): Promise<Result<User, SignUpError>> {
  // Password sign-in stays for the accounts that have a password. It can go
  // when every such account has a passkey (Settings → Passkeys shows who is
  // left) and recovery without a password exists (#1618): then delete this
  // action's password path, `verifyPassword`'s doors and the password column.
  if (signupClosed(app)) return err("signup_closed");
  if (app.config.passkeyOnlySignup === true) return err("passkey_required");
  const secret = app.config.turnstileSecret;
  // The terminal cannot render a widget, so with a secret set it brings no
  // token and is refused, the forge's first account too: sign up on the web page.
  if (secret !== undefined) {
    const verify = app.config.verifyHuman ?? turnstileVerifier(secret);
    // Before a password is hashed or a row is written.
    if (!(await verify(input.humanToken ?? "", from.address)))
      return err("human_check");
  }
  const { humanToken: _token, ...account } = input;
  const created = await createUser(app.db, { ...account, origin: "signup", slot: from.slot });
  if (!created.ok) return created;
  app.bus.append({
    kind: "user.created",
    actorId: created.value.id,
    payload: {
      via: "signup",
      ...(from.address === undefined ? {} : { address: from.address }),
    },
  });
  // The address is proven by the link it is sent; until then nothing it
  // does may create or cost.
  await welcome(app, created.value);
  return created;
}

export interface PasskeySignUpInput {
  username: string;
  email: string;
  /** The verified key (`verifyRegistration`) and what its owner calls the device. */
  passkey: Credential;
  passkeyName: string;
  humanToken?: string;
}

/**
 * Sign up with a passkey and an email address: the one way a new account is
 * made. The account has no password. The key was verified by the caller
 * against a challenge this forge issued. The account is made, then its key;
 * a refused key takes the account back (the hash-free insert cannot yield to
 * another request, so no transaction spans the two calls).
 */
export async function signUpWithPasskey(
  app: App,
  input: PasskeySignUpInput,
  from: { slot: SignupSlot; address?: string | undefined },
): Promise<Result<User, SignUpError | "passkey_taken">> {
  if (signupClosed(app)) return err("signup_closed");
  const secret = app.config.turnstileSecret;
  if (secret !== undefined) {
    const verify = app.config.verifyHuman ?? turnstileVerifier(secret);
    if (!(await verify(input.humanToken ?? "", from.address)))
      return err("human_check");
  }
  if (findPasskey(app.db, input.passkey.id)) return err("passkey_taken");
  const created = await createUser(app.db, {
    username: input.username,
    email: input.email,
    origin: "passkey",
    slot: from.slot,
  });
  if (!created.ok) return created;
  const kept = addPasskey(app.db, created.value.id, input.passkeyName, input.passkey);
  if (!kept.ok) {
    discardFreshUser(app.db, created.value.id);
    return err("passkey_taken");
  }
  app.bus.append({
    kind: "user.created",
    actorId: created.value.id,
    payload: {
      via: "signup",
      ...(from.address === undefined ? {} : { address: from.address }),
    },
  });
  await welcome(app, created.value);
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
  options: { expiresAt?: string } = {},
): Result<{ id: string; token: string }, "unauthorized"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const minted = mintToken(app.db, user.value.id, name, scope, options);
  app.bus.append({
    kind: "token.created",
    actorId: user.value.id,
    payload: {
      tokenId: minted.id,
      name,
      scope,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    },
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
): Result<
  User,
  | "unauthorized"
  | "display_name_reserved"
  | "display_name_mixed_script"
  | UpdateProfileError
> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // A display name is read beside every comment: nobody else may wear the
  // crew's, the owner's or the forge's.
  // Judged as it will be stored (\`cleanDisplayName\`), not as it was typed.
  const displayName =
    patch.displayName === undefined
      ? undefined
      : cleanDisplayName(patch.displayName);
  const reserved =
    displayName !== undefined && displayName !== user.value.displayName
      ? reservedName(app.db, displayName, user.value.id, "display")
      : undefined;
  // A mix of alphabets is refused for what it is, not as someone's name.
  if (reserved === "mixed") return err("display_name_mixed_script");
  if (reserved !== undefined) return err("display_name_reserved");
  const updated = writeProfile(app.db, user.value.id, patch);
  if (!updated.ok) return updated;
  // A new address is unproven at once; its link follows (and can be asked
  // for again), so a send that fails never leaves the old proof standing.
  if (updated.value.email.toLowerCase() !== user.value.email.toLowerCase())
    void emailChanged(app, updated.value);
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
