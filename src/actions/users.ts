/**
 * Account actions: signing up, minting and revoking tokens, and the SSH keys
 * an account authenticates with over the SSH listener.
 */

import { PASSWORD_TOO_LONG, withinPasswordCap } from "../core/hash-gate.ts";
import { emailChanged, welcome } from "./verify.ts";
import type { App } from "../app.ts";
import type { Credential } from "../auth/webauthn.ts";
import { addPasskey, findPasskey } from "../core/passkeys.ts";
import {
  addKey,
  deleteKey,
  keyName,
  parseAuthorizedKey,
  renameKey,
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
import { mintViaToken, VIA_TOKEN_MAX_MS } from "../core/via_token.ts";
import { id } from "../kernel/id.ts";
import { inviteSpentBy } from "../core/invites.ts";
import {
  changePassword as rehash,
  cleanDisplayName,
  createUser,
  discardFreshUser,
  newAccountsClosed,
  updateProfile as writeProfile,
  verifyPasswordThrottled,
  type CreateUserError,
  type ProfilePatch,
  type UpdateProfileError,
  type User,
  isStandInEmail,
} from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";
import type { SignupSlot } from "./signup-window.ts";

export interface SignUpInput {
  username: string;
  /** Optional: absent or blank, the account has none and nothing is mailed. */
  email?: string;
  password: string;
  /** The Turnstile token the browser's widget gave; read only when a secret is set. */
  humanToken?: string;
}

export type SignUpError =
  | CreateUserError
  | "human_check"
  | "invalid_email"
  | "passkey_required"
  | "signup_closed";

/** What anyone is told when the forge makes no new accounts. */
export const SIGNUP_CLOSED_MESSAGE = "Signup is closed on this forge.";

/**
 * Whether no new account may be made now. Read from the store on every call,
 * so a change takes effect on the next request. While signup is `invite`, an
 * open invite link's token opens it (`core/invites.ts`). The forge's first
 * account is no exception.
 */
export function signupClosed(app: App, invite?: string): boolean {
  return newAccountsClosed(app.db, invite);
}

/** What a person with an invite link that no longer opens the door is told. */
export const INVITE_SPENT_MESSAGE =
  "This invite link has been used, revoked or has expired. Ask whoever sent it for a new one.";

/** What anyone is told at a door that still offers a password-only sign-up. */
export const PASSKEY_REQUIRED_MESSAGE =
  "New accounts sign up with a passkey and an email address. Open the sign-up page in a browser and choose \u201cCreate account with a passkey\u201d.";

/** A plausible address: one @, no spaces. The link sent to it is the proof. */
export function plausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** The shortest password a sign-up takes. */
export const MIN_SIGNUP_PASSWORD = 12;

/**
 * Stands in for the address of an account that gave none: the column is
 * unique and never empty, and `.invalid` is a name no mail can reach
 * (the same device the crew's addresses use).
 */
export const noEmail = (username: string): string => `${username.toLowerCase()}@no-email.invalid`;

/** Whether an address is one a person could have given: plausible and not a stand-in. */
export const givenEmail = (email: string): boolean => plausibleEmail(email) && !isStandInEmail(email);

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
    /** The token of the invite link the person came by (`core/invites.ts`). */
    invite?: string | undefined;
    address?: string | undefined;
  },
): Promise<Result<User, SignUpError>> {
  // A username and a password is a way in that stays, beside the passkey
  // (#2923; it once was to go, #1618). Email is optional: given, the verify
  // link goes to it. Either way the account starts unproven: adding and
  // proving an address in settings is what lets it create and cost.
  if (signupClosed(app, from.invite)) return err("signup_closed");
  if (app.config.passkeyOnlySignup === true) return err("passkey_required");
  const email = (input.email ?? "").trim();
  if (email !== "" && !givenEmail(email)) return err("invalid_email");
  if (input.password.length < MIN_SIGNUP_PASSWORD) return err("weak_password");
  if (!withinPasswordCap(input.password)) return err("password_too_long");
  const secret = app.config.turnstileSecret;
  // The terminal cannot render a widget, so with a secret set it brings no
  // token and is refused, the forge's first account too: sign up on the web page.
  if (secret !== undefined) {
    const verify = app.config.verifyHuman ?? turnstileVerifier(secret);
    // Before a password is hashed or a row is written.
    if (!(await verify(input.humanToken ?? "", from.address)))
      return err("human_check");
  }
  const created = await createUser(app.db, {
    username: input.username,
    password: input.password,
    email: email === "" ? noEmail(input.username) : email,
    origin: "signup",
    slot: from.slot,
    invite: from.invite,
  });
  if (!created.ok) return created;
  app.bus.append({
    kind: "user.created",
    actorId: created.value.id,
    payload: {
      via: "signup",
      ...(from.address === undefined ? {} : { address: from.address }),
    },
  });
  auditInvite(app, created.value.id);
  // The address is proven by the link it is sent; until then nothing it
  // does may create or cost.
  if (email !== "") await welcome(app, created.value);
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
  from: { slot: SignupSlot; invite?: string | undefined; address?: string | undefined },
): Promise<Result<User, SignUpError | "passkey_taken">> {
  if (signupClosed(app, from.invite)) return err("signup_closed");
  const secret = app.config.turnstileSecret;
  if (secret !== undefined) {
    const verify = app.config.verifyHuman ?? turnstileVerifier(secret);
    if (!(await verify(input.humanToken ?? "", from.address)))
      return err("human_check");
  }
  if (findPasskey(app.db, input.passkey.id)) return err("passkey_taken");
  const email = input.email.trim();
  if (email !== "" && !givenEmail(email)) return err("invalid_email");
  const created = await createUser(app.db, {
    username: input.username,
    email: email === "" ? noEmail(input.username) : email,
    origin: "passkey",
    slot: from.slot,
    invite: from.invite,
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
  auditInvite(app, created.value.id);
  // As on the password path: no address given, no link to send.
  if (email !== "") await welcome(app, created.value);
  return created;
}

/** Using an invite link is an event: the invite's id and who it let in, never its token. */
function auditInvite(app: App, userId: string): void {
  const inviteId = inviteSpentBy(app.db, userId);
  if (inviteId !== undefined)
    app.bus.append({ kind: "invite.used", actorId: userId, payload: { id: inviteId } });
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
): Result<{ id: string; token: string }, "unauthorized" | "forbidden"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  // A token that acts as admin is for an admin to hold; ro and rw are anyone's.
  if (scope === "admin" && !user.value.isAdmin) return err("forbidden");
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

/** Most conversation tokens one person holds alive at once (#8321). */
export const CONVERSATION_TOKENS_MAX = 30;

/**
 * Mint the token the forge's agent acts with in one conversation: the
 * person's own, rw, expiring within the turn (`core/via_token.ts`), gated to
 * `/mcp` and fenced there. Without `conversation` a fresh one starts; with
 * it, only one this person's earlier token named, so nobody resets the
 * fence's marks of a conversation that is not theirs. `words` are what the
 * person said to start the turn. The caller owes the door: the person's own
 * session, same-origin, never a token.
 */
export function mintConversationToken(
  app: App,
  actor: User | undefined,
  input: { conversation?: string; words: string },
): Result<{ id: string; token: string; expiresAt: string; via: string }, "unauthorized" | "invalid_via" | "rate_limited"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const via = `conversation:${input.conversation ?? id()}`;
  if (input.conversation !== undefined) {
    const theirs = app.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM via_token v JOIN token t ON t.id = v.token_id WHERE v.via = ?1 AND t.user_id = ?2",
      )
      .get(via, user.value.id);
    if (!theirs || theirs.n === 0) return err("invalid_via");
  }
  // A token lives an hour, so what is alive is what one session minted in it.
  const alive = app.db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM via_token v JOIN token t ON t.id = v.token_id WHERE t.user_id = ?1 AND t.expires_at > ?2",
    )
    .get(user.value.id, new Date().toISOString());
  if (alive !== null && alive.n >= CONVERSATION_TOKENS_MAX) return err("rate_limited");
  const expiresAt = new Date(Date.now() + VIA_TOKEN_MAX_MS).toISOString();
  const minted = mintViaToken(app.db, user.value.id, via, input.words, expiresAt);
  if (!minted.ok) return err("invalid_via");
  app.bus.append({
    kind: "token.created",
    actorId: user.value.id,
    payload: { tokenId: minted.value.id, name: `via:${via}`, scope: "rw", expiresAt, via },
  });
  return ok({ ...minted.value, expiresAt, via });
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
  | "throttled"
  | "weak_password"
  | "password_too_long";

/**
 * What a refused password change reads as, one sentence each: Settings ›
 * Password and the terminal's Sessions screen say the same words.
 */
export const CHANGE_PASSWORD_WORDS: Record<ChangePasswordError, string> = {
  unauthorized: "Something went wrong.",
  bad_credentials: "That isn't your current password.",
  throttled: "Too many attempts. Try again in a minute.",
  weak_password: "Passwords need at least 10 characters.",
  password_too_long: PASSWORD_TOO_LONG,
};

/** What a changed password reads as, on every surface. */
export const PASSWORD_CHANGED_WORDS = "Password changed. Existing sessions stay signed in.";

/** Replace the password; the current one must be presented and verified. */
export async function changePassword(
  app: App,
  actor: User | undefined,
  input: { current: string; next: string; source: string },
): Promise<Result<void, ChangePasswordError>> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  const verified = await verifyPasswordThrottled(app.db, {
    username: user.value.username,
    password: input.current,
    source: input.source,
  });
  if (!verified.ok) return err(verified.error.reason);
  const changed = await rehash(app.db, user.value.id, input.next);
  if (!changed.ok)
    return err(
      changed.error === "weak_password" || changed.error === "password_too_long"
        ? changed.error
        : "unauthorized",
    );
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

/** Rename one of the actor's keys, so each says which machine holds it. */
export function renameSshKey(
  app: App,
  actor: User | undefined,
  keyId: string,
  name: string,
): Result<void, "unauthorized" | "not_found" | "invalid_name"> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  if (keyName(name) === undefined) return err("invalid_name");
  if (!renameKey(app.db, user.value.id, keyId, name)) return err("not_found");
  app.bus.append({
    kind: "user.key_renamed",
    actorId: user.value.id,
    payload: { keyId },
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
