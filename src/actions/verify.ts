/**
 * Proving an email. Signing up, or changing the address, sends a one-time
 * link; following it proves the address. Until then the account can sign in
 * and read, but nothing it does may create or cost (`requireVerified`, asked
 * by every action that would). A forge with no mail configured sends
 * nothing: the newcomer waits for the owner's word, and the log says why
 * without carrying the link.
 */

import type { App } from "../app.ts";
import {
  consumeLink,
  emailVerified,
  issueLink,
  issueRecovery,
  recoveryOwner,
  spendRecovery,
  resetVerification,
} from "../core/verify.ts";
import { listSecretNames, resolveSecrets } from "../core/secret_store.ts";
import { getUserById, isActive, type User } from "../core/users.ts";
import { sendMail, type Mailer } from "../kernel/mail.ts";
import { mayMail, sendCapped } from "./mail.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";
import { VERIFY_FIRST } from "./verify_words.ts";

/** The words every refusal carries, on every surface. */
export const UNVERIFIED_MESSAGE = VERIFY_FIRST;

/** An account that may create and cost: its email is proven. */
export function requireVerified(
  app: App,
  user: User,
): Result<User, "unverified"> {
  return emailVerified(app.db, user.id) ? ok(user) : err("unverified");
}

/** The forge-level secrets that configure mail, set live at /settings/secrets. */
export const MAIL_SECRETS = ["MAIL_SMTP_URL", "MAIL_FROM"] as const;

/**
 * Where mail goes: the forge-level secrets first (the owner sets them at
 * /settings/secrets, no restart), else FORGE_SMTP_URL / FORGE_MAIL_FROM read
 * at boot. Both of a pair, or neither. Read per message, so a changed secret
 * takes effect on the next mail; each read is audited by the store.
 */
/**
 * Whether the forge can send mail at all — both secrets set, or the boot
 * configuration. Asked by name only: nothing is opened to answer it.
 */
export function mailConfigured(app: App): boolean {
  if (app.config.mailer !== undefined || app.config.mail !== undefined)
    return true;
  const set = new Set(listSecretNames(app.db, "forge").map((s) => s.name));
  return MAIL_SECRETS.every((name) => set.has(name));
}

export function mailerOf(app: App, forUser: { readonly id: string }): Mailer | undefined {
  if (app.config.mailer !== undefined) return app.config.mailer;
  const stored = resolveSecrets(
    app.db,
    app.config.dataDir,
    app.bus,
    MAIL_SECRETS,
    // The store's audit names who a read was for: the person mailed.
    { actor: forUser.id },
  );
  const url = stored["MAIL_SMTP_URL"];
  const from = stored["MAIL_FROM"];
  const config =
    url !== undefined && from !== undefined ? { url, from } : app.config.mail;
  return config === undefined ? undefined : (mail) => sendMail(config, mail);
}

function verifyUrl(app: App, token: string): string {
  const base = app.config.url ?? `http://localhost:${app.config.port}`;
  return `${new URL("/verify", base).toString()}?token=${token}`;
}

/**
 * Send the account a fresh link, if one may go now. "sent" when it went,
 * "too_soon" inside the resend window, "no_mail" when the forge cannot send,
 * "capped" when the forge's mail caps hold it (`actions/mail.ts`).
 */
export async function sendVerification(
  app: App,
  user: User,
  now: number = Date.now(),
): Promise<"sent" | "too_soon" | "no_mail" | "capped" | "failed"> {
  const mailer = mailerOf(app, user);
  if (mailer === undefined) {
    app.log.warn("mail is not configured; a verification link was not sent", {
      user: user.username,
    });
    return "no_mail";
  }
  // Asked before a link is made, so a capped send spends none of the
  // account's own links; asked again as it goes (`sendCapped`).
  if (!mayMail(app, user.email, now)) return "capped";
  const token = issueLink(app.db, user.id, user.email, now);
  if (token === undefined) return "too_soon";
  const link = verifyUrl(app, token);
  const outcome = await sendCapped(app, mailer, {
    to: user.email,
    subject: "Verify your email for the forge",
    text: [
      `Hello ${user.username},`,
      "",
      "Follow this link to prove this address is yours. It works once, for a day:",
      "",
      link,
      "",
      "If you did not sign up, ignore this message.",
    ].join("\n"),
  }, now);
  if (outcome === "capped") return "capped";
  if (outcome === "failed") {
    app.log.warn("a verification link could not be sent", {
      user: user.username,
    });
    return "failed";
  }
  return "sent";
}

/** After a sign-up: the address is proven by the link it is sent, the first account's too. */
export async function welcome(app: App, user: User): Promise<void> {
  resetVerification(app.db, user.id);
  await sendVerification(app, user);
}

/**
 * A changed address must be proven again. The reset happens before the
 * first await, so a caller that does not wait still leaves it unproven.
 */
export async function emailChanged(app: App, user: User): Promise<void> {
  resetVerification(app.db, user.id);
  await sendVerification(app, user);
}

/** Follow a link. The account it proved, or `invalid` for a used or stale one. */
export function verifyEmail(app: App, token: string): Result<User, "invalid"> {
  const userId = consumeLink(app.db, token, Date.now());
  const user = userId === undefined ? undefined : getUserById(app.db, userId);
  if (user === undefined) return err("invalid");
  app.bus.append({ kind: "account.email_verified", actorId: user.id });
  return ok(user);
}

/** The person asks for another link. */
export async function resendVerification(
  app: App,
  actor: User | undefined,
): Promise<
  Result<
    "sent" | "already",
    "unauthorized" | "too_soon" | "no_mail" | "capped" | "failed"
  >
> {
  const user = requireUser(actor);
  if (!user.ok) return user;
  if (emailVerified(app.db, user.value.id)) return ok("already");
  const outcome = await sendVerification(app, user.value);
  return outcome === "sent" ? ok("sent") : err(outcome);
}

function recoveryUrl(app: App, token: string): string {
  const base = app.config.url ?? `http://localhost:${app.config.port}`;
  return `${new URL("/recover", base).toString()}?token=${token}`;
}

/**
 * Someone who cannot sign in asks for a way back by address. Nothing here
 * tells an address with an account from one without: the caller answers the
 * same either way. A link goes only to a person whose email is proven, is
 * not suspended or removed, and only when the forge can send mail. The send
 * is not waited for, so the answer takes as long for a stranger as for a
 * member.
 */
export function requestRecovery(
  app: App,
  email: string,
  now: number = Date.now(),
): void {
  const row = app.db
    .query<{ id: string }, [string]>(
      "SELECT id FROM user WHERE email = ?1 COLLATE NOCASE AND kind = 'user' AND is_agent = 0",
    )
    .get(email.trim());
  const user = row === null ? undefined : getUserById(app.db, row.id);
  if (user === undefined || !isActive(user)) return;
  const mailer = mailerOf(app, user);
  if (mailer === undefined || !mayMail(app, user.email, now)) return;
  const token = issueRecovery(app.db, user.id, now);
  if (token === undefined) return;
  void sendCapped(app, mailer, {
    to: user.email,
    subject: "Get back into your forge account",
    text: [
      `Hello ${user.username},`,
      "",
      "Follow this link to register a new passkey and sign in. It works once, for 30 minutes:",
      "",
      recoveryUrl(app, token),
      "",
      "If you did not ask for this, ignore this message.",
    ].join("\n"),
  }, now).catch(() => undefined);
}

/** The account a recovery link is for, if it still works; nothing is spent. */
export function recoveryAccount(app: App, token: string): User | undefined {
  const id = recoveryOwner(app.db, token, Date.now());
  const user = id === undefined ? undefined : getUserById(app.db, id);
  return user !== undefined && isActive(user) ? user : undefined;
}

/** Spend the link: the account to sign in, or `invalid` for a used or stale one. */
export function spendRecoveryLink(app: App, token: string): Result<User, "invalid"> {
  const id = spendRecovery(app.db, token, Date.now());
  const user = id === undefined ? undefined : getUserById(app.db, id);
  if (user === undefined || !isActive(user)) return err("invalid");
  app.bus.append({ kind: "account.recovered", actorId: user.id });
  return ok(user);
}
