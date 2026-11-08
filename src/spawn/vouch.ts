/**
 * Whether a request to a hosted child carries a credential that child would
 * accept: a live session cookie, or a live token (Bearer, `token`, or as a
 * Basic password), of an active account in the child's own database. Only a
 * verified credential is kind to the wake limits or keeps a forge awake; a
 * header a stranger merely wrote counts for nothing.
 *
 * Read-only: no last-seen writes, so a sleeping forge's database is only read.
 * A password in Basic is not checked here (hashing it per request is the cost
 * the limits exist to avoid); that request is a stranger's to the limits.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cookieValue } from "../http/context.ts";
import { tokenSecret } from "../http/token_header.ts";
import { sha256 } from "../kernel/hash.ts";
import { getUserById, isActive } from "../core/users.ts";

/** The secrets a request presents, unverified: a session cookie and a token. */
export function presented(request: Request): { session?: string; token?: string } {
  const out: { session?: string; token?: string } = {};
  const session = cookieValue(request, "forge_session");
  if (session !== undefined && session !== "" && session.length <= 512) out.session = session;
  const header = request.headers.get("authorization");
  if (header !== null && header.length <= 4096) {
    const secret = tokenSecret(header);
    if (secret !== null) out.token = secret;
    else if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString();
      const colon = decoded.indexOf(":");
      const password = colon === -1 ? "" : decoded.slice(colon + 1);
      if (password.startsWith("forge_")) out.token = password;
    }
  }
  return out;
}

const live = (expires: string | null, now: number): boolean =>
  expires === null || Date.parse(expires) > now;

function activeUser(db: Database, userId: string): boolean {
  const user = getUserById(db, userId);
  return user !== undefined && isActive(user);
}

/** Whether `db` vouches for the request's session or token. */
export function vouchedIn(db: Database, request: Request, now = Date.now()): boolean {
  const { session, token } = presented(request);
  if (session !== undefined) {
    const row = db
      .query<{ user_id: string; expires_at: string }, [string]>("SELECT user_id, expires_at FROM session WHERE token_hash = ?1")
      .get(sha256(session));
    if (row && live(row.expires_at, now) && activeUser(db, row.user_id)) return true;
  }
  if (token !== undefined) {
    const row = db
      .query<{ user_id: string; expires_at: string | null }, [string]>("SELECT user_id, expires_at FROM token WHERE token_hash = ?1")
      .get(sha256(token));
    if (row && live(row.expires_at, now) && activeUser(db, row.user_id)) return true;
  }
  return false;
}

/**
 * Whether the child whose data is in `dataDir` vouches for the request. `open`
 * is its database when it is open in this process; otherwise its file is
 * opened read-only for the one look. A request presenting nothing opens nothing.
 */
export function vouched(dataDir: string, request: Request, open?: Database): boolean {
  const { session, token } = presented(request);
  if (session === undefined && token === undefined) return false;
  if (open !== undefined) return vouchedIn(open, request);
  const path = join(dataDir, "forge.db");
  if (!existsSync(path)) return false;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return vouchedIn(db, request);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
