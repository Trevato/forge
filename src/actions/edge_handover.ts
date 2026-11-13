/**
 * Who may mint a way-back link (`core/edge_handover.ts`) and for whom: a
 * forge admin, a person (not an agent), for an active account that is not
 * an admin, is mapped to a platform edge login, and has no way in of its
 * own. Anyone else is told the account is not there, like every admin
 * surface (`actions/signins.ts`). An admin who signs in only through the
 * edge adds a passkey while the edge still answers: switching the edge off
 * already refuses to strand them (`actions/capacity.ts`).
 *
 * Opening the link is the recovery step (`actions/verify.ts`
 * `recoveryAccount`, `spendRecoveryLink`): a new passkey, then a session.
 */

import type { App } from "../app.ts";
import { signinReach, signsInWithoutEdge } from "../core/accounts.ts";
import { linkedLogin } from "../core/edge_links.ts";
import { HANDOVER_TTL_MS, issueHandover } from "../core/edge_handover.ts";
import { getUserByName, isActive, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";

export interface WayBack {
  readonly username: string;
  /** The edge login the account is mapped to. */
  readonly login: string;
  /** The link to hand over, absolute when the forge knows its address. */
  readonly url: string;
  readonly expiresAt: string;
}

export type WayBackRefusal = "not_found" | "has_way_in";

/** An account a way-back link can be made for, and the edge login it is mapped to. */
export interface Stranded {
  readonly username: string;
  readonly login: string;
}

const mayMint = (actor: User | undefined): User | undefined => {
  const asker = requireUser(actor);
  return asker.ok && asker.value.isAdmin && asker.value.kind === "user" ? asker.value : undefined;
};

/**
 * The accounts a way-back link can be made for, in the order Accounts names
 * them: the ones `mintWayBack` would mint for. The page and the terminal
 * screen (`tui/screens/wayback.ts`) offer the same list behind the same gate.
 */
export function wayBackAccounts(app: App, actor: User | undefined): Result<Stranded[], "not_found"> {
  if (mayMint(actor) === undefined) return err("not_found");
  const out: Stranded[] = [];
  for (const a of signinReach(app.db).stranded) {
    if (a.isAdmin) continue;
    const user = getUserByName(app.db, a.username);
    if (user === undefined || user.kind !== "user" || !isActive(user)) continue;
    const login = linkedLogin(app.db, user.id);
    if (login !== undefined) out.push({ username: user.username, login });
  }
  return ok(out);
}

/** Mint (or replace) the way-back link for `username`. */
export function mintWayBack(
  app: App,
  actor: User | undefined,
  username: string,
  now: number = Date.now(),
): Result<WayBack, WayBackRefusal> {
  const asker = mayMint(actor);
  if (asker === undefined) return err("not_found");
  const user = getUserByName(app.db, username);
  if (user === undefined || user.kind !== "user" || user.isAdmin || !isActive(user)) return err("not_found");
  const login = linkedLogin(app.db, user.id);
  if (login === undefined) return err("not_found");
  if (signsInWithoutEdge(app.db, user.id)) return err("has_way_in");
  const token = issueHandover(app.db, user.id, asker.id, now);
  app.bus.append({ kind: "account.way_back_minted", actorId: asker.id, payload: { userId: user.id } });
  return ok({
    username: user.username,
    login,
    url: wayBackUrl(app, token),
    expiresAt: new Date(now + HANDOVER_TTL_MS).toISOString(),
  });
}

function wayBackUrl(app: App, token: string): string {
  const path = `/recover?token=${encodeURIComponent(token)}`;
  return app.config.url === undefined ? path : new URL(path, app.config.url).toString();
}
