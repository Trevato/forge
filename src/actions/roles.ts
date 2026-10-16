/**
 * Promote a guest to member, or demote a member, with a starter model
 * allowance on the way up. A forge admin who is a person only; the change is
 * an event on the outbox. `requireAbility` is the one place the other actions
 * ask what a role may do, after every older refusal has had its say.
 */

import type { App } from "../app.ts";
import { setModelGrant, validGrant } from "../core/model_grant.ts";
import { lacks, roleOf, setMember, type Ability } from "../core/roles.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";

/** `user` unless the table withholds `ability` from their role: then `not_member`. */
export function requireAbility(app: App, user: User, ability: Ability): Result<User, "not_member"> {
  return lacks(app.db, user, ability) ? err("not_member") : ok(user);
}

export type RoleError = "not_found" | "not_allowed" | "invalid_amount";

export function setRole(
  app: App,
  actor: User | undefined,
  username: string,
  role: "member" | "guest",
  usd: number | null = null,
): Result<{ username: string; role: "member" | "guest"; usdPerMonth: number | null }, RoleError> {
  const admin = requireUser(actor);
  if (!admin.ok || !admin.value.isAdmin || admin.value.kind !== "user") return err("not_found");
  const user = getUserByName(app.db, username);
  if (user === undefined || user.kind === "org") return err("not_found");
  if (user.kind === "agent" || user.isAdmin) return err("not_allowed");
  if (role === "member" && usd !== null && !validGrant(usd)) return err("invalid_amount");
  const was = roleOf(app.db, user);
  const grant = role === "member" && usd !== null ? Math.round(usd * 100) / 100 : null;
  app.db.transaction(() => {
    setMember(app.db, user.id, role === "member", admin.value.id, new Date());
    if (grant !== null && was === "guest") setModelGrant(app.db, user.id, grant, admin.value.id, new Date());
  })();
  const usdPerMonth = was === "guest" ? grant : null;
  // The grant is audited as `setAccountGrant` audits it.
  if (usdPerMonth !== null)
    app.bus.append({
      kind: "account.model_granted",
      actorId: admin.value.id,
      payload: { username: user.username, usdPerMonth },
    });
  if (was !== role)
    app.bus.append({
      kind: "account.role_set",
      actorId: admin.value.id,
      payload: { username: user.username, role, usdPerMonth },
    });
  return ok({ username: user.username, role, usdPerMonth });
}
