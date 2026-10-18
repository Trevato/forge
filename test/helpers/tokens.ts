import type { App } from "../../src/app.ts";
import { createToken } from "../../src/core/tokens.ts";
import { getUserByName } from "../../src/core/users.ts";

/**
 * A token of a scope for an account a suite already made, minted directly:
 * the API refuses `admin` to a non-admin (#2425), and suites that want a
 * member's full-account token take it here, as the operator's tools would.
 */
export function tokenFor(app: App, username: string, scope: "ro" | "rw" | "admin", name = "t"): string {
  const user = getUserByName(app.db, username);
  if (!user) throw new Error(`no account ${username}`);
  return createToken(app.db, user.id, name, scope).token;
}
