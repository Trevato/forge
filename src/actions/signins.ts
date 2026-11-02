/**
 * Where an account is signed in: its access tokens and its browsers, and
 * the one act on each, ending it. A person sees and ends their own; the
 * forge's owner sees and ends any person's — not another admin's, not an
 * agent's (the crew's credentials are the crew page's). Anyone else is told
 * the account is not there (`not_found`), like every admin surface.
 */

import type { App } from "../app.ts";
import {
  destroySession,
  endSession,
  listSessions,
  sessionOf,
  type SessionInfo,
} from "../core/sessions.ts";
import { listTokensWithClients, type ListedToken } from "../core/oauth.ts";
import { deleteToken } from "../core/tokens.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";

export interface SignIns {
  readonly user: User;
  readonly tokens: readonly ListedToken[];
  readonly sessions: readonly SessionInfo[];
}

/** The account `actor` may see the sign-ins of, by name. */
function whose(
  app: App,
  actor: User | undefined,
  username: string,
): Result<User, "not_found"> {
  const asker = requireUser(actor);
  if (!asker.ok) return err("not_found");
  const user = getUserByName(app.db, username);
  if (user === undefined || user.kind !== "user") return err("not_found");
  if (user.id === asker.value.id) return ok(user);
  const owner = asker.value.isAdmin && asker.value.kind === "user";
  return owner && !user.isAdmin && user.removedAt === null
    ? ok(user)
    : err("not_found");
}

/** An account's tokens and live browsers; `current` marks the asker's own. */
export function accountSignIns(
  app: App,
  actor: User | undefined,
  username: string,
  current?: string,
): Result<SignIns, "not_found"> {
  const user = whose(app, actor, username);
  if (!user.ok) return user;
  return ok({
    user: user.value,
    tokens: listTokensWithClients(app.db, user.value.id),
    sessions: listSessions(
      app.db,
      user.value.id,
      user.value.id === actor?.id ? current : undefined,
    ),
  });
}

/** An owner ending someone else's sign-in is on the record; one's own is not. */
function audited(
  app: App,
  actor: User,
  user: User,
  what: "token" | "session",
): void {
  if (actor.id === user.id) return;
  app.bus.append({
    kind: "account.signed_out",
    actorId: actor.id,
    payload: { username: user.username, what },
  });
}

/** Revoke one of an account's tokens. */
export function revokeAccountToken(
  app: App,
  actor: User | undefined,
  username: string,
  tokenId: string,
): Result<void, "not_found"> {
  const user = whose(app, actor, username);
  if (!user.ok) return user;
  if (!deleteToken(app.db, user.value.id, tokenId)) return err("not_found");
  audited(app, actor!, user.value, "token");
  return ok();
}

/**
 * Sign out the browser asking: the same path as ending it from Settings, so
 * the streams its other tabs hold end now, not when they next reconnect.
 * The cookie is what names the browser, whatever else signed the request
 * in (the platform edge goes first). One that no longer names a live
 * session is simply forgotten.
 */
export function signOutHere(app: App, token: string | undefined): void {
  if (token === undefined) return;
  const found = sessionOf(app.db, token);
  if (found.ok) {
    const { user, id } = found.value;
    endAccountSession(app, user, user.username, id);
  } else destroySession(app.db, token);
}

/** Sign one of an account's browsers out. */
export function endAccountSession(
  app: App,
  actor: User | undefined,
  username: string,
  sessionId: string,
): Result<void, "not_found"> {
  const user = whose(app, actor, username);
  if (!user.ok) return user;
  if (!endSession(app.db, user.value.id, sessionId)) return err("not_found");
  audited(app, actor!, user.value, "session");
  // The browser's open streams end with it (the listener's `session.ended`).
  app.bus.append({
    kind: "session.ended",
    actorId: actor!.id,
    payload: { sessionId },
  });
  return ok();
}
