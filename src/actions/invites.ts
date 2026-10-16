/**
 * An admin mints, lists and revokes invite links (#2335). Each mint and
 * revoke is an event, which is the audit; the token is in none of them.
 */

import type { App } from "../app.ts";
import { listInvites, mintInvite, parseDays, revokeInvite, type Invite } from "../core/invites.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { User } from "../core/users.ts";

type Error = "not_found" | "invalid_days";

const admin = (actor: User | undefined): actor is User =>
  actor !== undefined && actor.isAdmin && actor.kind === "user";

/** The link an admin hands over: the signup page with the token in it. */
export const inviteLink = (origin: string, token: string): string =>
  `${origin.replace(/\/$/, "")}/signup?invite=${token}`;

export function mint(app: App, actor: User | undefined, days: unknown): Result<{ invite: Invite; token: string }, Error> {
  if (!admin(actor)) return err("not_found");
  const n = parseDays(days);
  if (!n.ok) return n;
  const made = mintInvite(app.db, actor.id, n.value);
  app.bus.append({
    kind: "invite.minted",
    actorId: actor.id,
    payload: { id: made.invite.id, expiresAt: made.invite.expiresAt },
  });
  return ok(made);
}

export function list(app: App, actor: User | undefined): Result<Invite[], "not_found"> {
  return admin(actor) ? ok(listInvites(app.db)) : err("not_found");
}

export function revoke(app: App, actor: User | undefined, inviteId: string): Result<Invite, "not_found"> {
  if (!admin(actor)) return err("not_found");
  const done = revokeInvite(app.db, inviteId);
  if (!done.ok) return done;
  app.bus.append({ kind: "invite.revoked", actorId: actor.id, payload: { id: inviteId } });
  return done;
}
