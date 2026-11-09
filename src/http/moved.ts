/**
 * A moved repository's old paths (#569). A web or API request under an
 * owner/name that a transfer left behind answers 308 to the same path under
 * the repository's new owner — a GET and a mutation alike, so a write is never
 * applied silently to the new place: the client re-sends it, knowing where.
 * Only a caller who may read the repository learns where it went; anyone else
 * keeps the 404 a missing path has always answered.
 */

import type { Database } from "bun:sqlite";
import { canRead } from "../core/repos.ts";
import { redirectFor } from "../core/transfer.ts";
import type { User } from "../core/users.ts";
import { isSafeName } from "../git/guard.ts";

const API = "/api/v1/repos/";

/** The owner/name a path names, its prefix and the rest; undefined when it names none. */
function repoPath(pathname: string): { prefix: string; owner: string; name: string; rest: string } | undefined {
  const prefix = pathname.startsWith(API) ? API : "/";
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length < 2) return undefined;
  const [owner, name] = parts as [string, string];
  if (!isSafeName(owner) || !isSafeName(name)) return undefined;
  return { prefix, owner, name, rest: parts.slice(2).join("/") };
}

export function movedResponse(db: Database, url: URL, user: User | undefined): Response | undefined {
  const at = repoPath(url.pathname);
  if (at === undefined) return undefined;
  const repo = redirectFor(db, at.owner, at.name);
  if (repo === undefined || !canRead(db, repo, user)) return undefined;
  const rest = at.rest === "" && !url.pathname.endsWith("/") ? "" : `/${at.rest}`;
  const location = `${at.prefix}${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}${rest}${url.search}`;
  return new Response(null, { status: 308, headers: { location } });
}
