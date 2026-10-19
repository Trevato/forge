/**
 * The link between an account here and the login the platform edge vouches
 * for. The edge signs people in by login; a link is how a person says that
 * login is theirs, so an edge sign-in reaches their account whatever it is
 * called here.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { getUserById, getUserByName, type User } from "./users.ts";

export type LinkError = "invalid_login" | "login_taken" | "already_linked";

/** The edge login linked to this account, if any. */
export function linkedLogin(db: Database, userId: string): string | undefined {
  const row = db
    .query<{ login: string }, [string]>("SELECT login FROM edge_link WHERE user_id = ?")
    .get(userId);
  return row?.login;
}

/** The account an edge login is linked to, if any. */
export function linkedUser(db: Database, login: string): User | undefined {
  const row = db
    .query<{ user_id: string }, [string]>("SELECT user_id FROM edge_link WHERE login = ?")
    .get(login);
  return row === null || row === undefined ? undefined : getUserById(db, row.user_id);
}

/**
 * Record `login` against the account. Refused when the login is not a
 * plain name, when another account holds it or is called by it (the link
 * would take that account's sign-in), or when this account is linked to a
 * different login already. Linking the same login again is a no-op.
 */
export function linkEdgeLogin(
  db: Database,
  user: User,
  login: string,
): Result<"linked", LinkError> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(login)) return err("invalid_login");
  const held = linkedUser(db, login);
  if (held !== undefined && held.id !== user.id) return err("login_taken");
  const named = getUserByName(db, login);
  if (named !== undefined && named.id !== user.id) return err("login_taken");
  const mine = linkedLogin(db, user.id);
  if (mine !== undefined) return mine.toLowerCase() === login.toLowerCase() ? ok("linked") : err("already_linked");
  db.query("INSERT INTO edge_link (login, user_id) VALUES (?, ?)").run(login, user.id);
  return ok("linked");
}

/** Remove the account's link; true when there was one. */
export function unlinkEdgeLogin(db: Database, userId: string): boolean {
  return db.query("DELETE FROM edge_link WHERE user_id = ?").run(userId).changes > 0;
}
