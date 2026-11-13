/**
 * An admin's hand on a person's access (#11688): a one-time link that lets
 * them set a new password (and add a passkey), and ending every browser they
 * are signed in on. The admin never sees or sets the password. Both are on
 * the audit trail with who did them, and the person is told by a notice the
 * next time they are here.
 *
 * Whom an admin may manage: a person who is still here, not themselves and
 * not an agent. Another admin only for the forge's owner (the first admin
 * still here); any other admin is told it is not allowed.
 */

import type { App } from "../app.ts";
import {
  accessLinkOwner,
  ACCESS_LINK_TTL_MS,
  leaveNotice,
  makeAccessLink,
  spendAccessLink,
} from "../core/access_link.ts";
import { withinPasswordCap } from "../core/hash-gate.ts";
import { listSessions } from "../core/sessions.ts";
import {
  getUserById,
  getUserByName,
  isActive,
  hashPassword,
  isStandInEmail,
  MIN_PASSWORD,
  setPasswordHash,
  type User,
} from "../core/users.ts";
import { emailVerified } from "../core/verify.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";
import { mailerOf } from "./verify.ts";
import { mayMail, sendCapped } from "./mail.ts";

export type AccessError = "not_found" | "not_allowed";

/** The first admin still here: the one person who may manage another admin. */
export function forgeOwner(app: App): string | undefined {
  return (
    app.db
      .query<{ id: string }, []>(
        `SELECT id FROM user WHERE is_admin = 1 AND kind = 'user' AND is_agent = 0
           AND removed_at IS NULL ORDER BY created_at, id LIMIT 1`,
      )
      .get()?.id ?? undefined
  );
}

/** The person `actor` may manage by name, with the admin acting. */
export function manageable(
  app: App,
  actor: User | undefined,
  username: string,
): Result<{ admin: User; user: User }, AccessError> {
  const asker = requireUser(actor);
  if (!asker.ok || !asker.value.isAdmin || asker.value.kind !== "user") return err("not_found");
  const user = getUserByName(app.db, username);
  if (user === undefined || user.kind !== "user" || user.removedAt !== null) return err("not_found");
  if (user.id === asker.value.id) return err("not_allowed");
  if (user.isAdmin && forgeOwner(app) !== asker.value.id) return err("not_allowed");
  return ok({ admin: asker.value, user });
}

/** The words an unlisted refusal carries on every surface. */
export const ACCESS_WORDS = {
  notAllowed: "You cannot do that to yourself or an agent, and only the forge's owner may do it to another admin.",
  invalid: "That link has been used or has expired. Ask an admin for a new one.",
} as const;

export interface AccessReset {
  readonly username: string;
  /** The secret of the link, shown once; absent on a dry run. */
  readonly token: string | undefined;
  readonly expiresAt: string | undefined;
  readonly sessionsEnded: number;
  /** Whether the forge mailed the link to the person's verified address. */
  readonly mailed: boolean;
  readonly dryRun: boolean;
}

const dateWords = (at: Date): string => at.toISOString().slice(0, 16).replace("T", " ") + " UTC";

function endSessions(app: App, userId: string): number {
  return app.db.query("DELETE FROM session WHERE user_id = ?1").run(userId).changes;
}

function linkUrl(app: App, token: string): string {
  const base = app.config.url ?? `http://localhost:${app.config.port}`;
  return new URL(`/signin/access/${token}`, base).toString();
}

/** The address of a link, from its secret. */
export const accessUrl = linkUrl;

/**
 * Make a person a one-time link, good for an hour, to set a new password
 * and add a passkey; `endAll` also ends every browser they are signed in
 * on. Mailed when the forge can send mail and the address is proven. With
 * `dryRun`, says what would happen and changes nothing.
 */
export async function resetAccess(
  app: App,
  actor: User | undefined,
  username: string,
  options: { endAll?: boolean; dryRun?: boolean; now?: number } = {},
): Promise<Result<AccessReset, AccessError>> {
  const found = manageable(app, actor, username);
  if (!found.ok) return found;
  const { admin, user } = found.value;
  const now = options.now ?? Date.now();
  const endAll = options.endAll === true;
  if (options.dryRun === true)
    return ok({
      username: user.username,
      token: undefined,
      expiresAt: new Date(now + ACCESS_LINK_TTL_MS).toISOString(),
      sessionsEnded: endAll ? listSessions(app.db, user.id).length : 0,
      mailed: false,
      dryRun: true,
    });
  const made = makeAccessLink(app.db, user.id, admin.id, now);
  const sessionsEnded = endAll ? endSessions(app, user.id) : 0;
  leaveNotice(app.db, user.id, `An admin reset your access on ${dateWords(new Date(now))}.`, new Date(now));
  app.bus.append({
    kind: "account.access_reset",
    actorId: admin.id,
    payload: { username: user.username, sessionsEnded, expiresAt: made.expiresAt },
  });
  const mailer = emailVerified(app.db, user.id) && !isStandInEmail(user.email) ? mailerOf(app, user) : undefined;
  let mailed = false;
  if (mailer !== undefined && mayMail(app, user.email, now))
    mailed =
      (await sendCapped(
        app,
        mailer,
        {
          to: user.email,
          subject: "Set a new password for your forge account",
          text: [
            `Hello ${user.username},`,
            "",
            "An admin made you a link to set a new password and add a passkey. It works once, for an hour:",
            "",
            linkUrl(app, made.token),
            "",
            "If you were not expecting this, tell the admin.",
          ].join("\n"),
        },
        now,
      ).catch(() => "failed")) === "sent";
  return ok({ username: user.username, token: made.token, expiresAt: made.expiresAt, sessionsEnded, mailed, dryRun: false });
}

/** End every browser a person is signed in on, and nothing else. */
export function endAllSessions(
  app: App,
  actor: User | undefined,
  username: string,
  options: { dryRun?: boolean } = {},
): Result<{ username: string; sessionsEnded: number; dryRun: boolean }, AccessError> {
  const found = manageable(app, actor, username);
  if (!found.ok) return found;
  const { admin, user } = found.value;
  if (options.dryRun === true)
    return ok({ username: user.username, sessionsEnded: listSessions(app.db, user.id).length, dryRun: true });
  const sessionsEnded = endSessions(app, user.id);
  leaveNotice(app.db, user.id, `An admin signed you out everywhere on ${dateWords(new Date())}.`, new Date());
  app.bus.append({
    kind: "account.sessions_ended",
    actorId: admin.id,
    payload: { username: user.username, sessionsEnded },
  });
  return ok({ username: user.username, sessionsEnded, dryRun: false });
}

/** The person a link is for while it still works; nothing is spent. */
export function accessLinkPerson(app: App, token: string, now: number = Date.now()): User | undefined {
  const id = accessLinkOwner(app.db, token, now);
  const user = id === undefined ? undefined : getUserById(app.db, id);
  return user !== undefined && isActive(user) ? user : undefined;
}

class NotRedeemed extends Error {}

export type RedeemError = "invalid" | "weak_password" | "password_too_long";

/**
 * Spend a link to set a new password. The password is checked and hashed
 * before the link is touched, so a short one, or a hash that fails, costs
 * nothing; the link is then spent and the password stored in one transaction,
 * so two at once cannot both set a password and no link is spent for nothing.
 */
export async function redeemAccessLink(
  app: App,
  token: string,
  password: string,
  now: number = Date.now(),
): Promise<Result<User, RedeemError>> {
  if (accessLinkPerson(app, token, now) === undefined) return err("invalid");
  if (password.length < MIN_PASSWORD) return err("weak_password");
  if (!withinPasswordCap(password)) return err("password_too_long");
  const hash = await hashPassword(password);
  let user: User | undefined;
  try {
    user = app.db.transaction((): User => {
      const id = spendAccessLink(app.db, token, now);
      const owner = id === undefined ? undefined : getUserById(app.db, id);
      // Throwing rolls the spend back: the link stays as it was.
      if (owner === undefined || !isActive(owner) || !setPasswordHash(app.db, owner.id, hash)) throw new NotRedeemed();
      return owner;
    })();
  } catch (error) {
    if (error instanceof NotRedeemed) return err("invalid");
    throw error;
  }
  app.bus.append({ kind: "account.access_redeemed", actorId: user.id, payload: { username: user.username } });
  return ok(user);
}
