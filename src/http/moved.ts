/**
 * A moved repository's old paths (#569). A web or API request under an
 * owner/name that a transfer left behind answers 308 to the same path under
 * the repository's new owner — a GET and a mutation alike, so a write is never
 * applied silently to the new place: the client re-sends it, knowing where.
 * Only a caller who may read the repository learns where it went; anyone else
 * keeps the 404 a missing path has always answered.
 */

import type { Database } from "bun:sqlite";
import { canRead, type Repo } from "../core/repos.ts";
import { redirectFor } from "../core/transfer.ts";
import type { User } from "../core/users.ts";
import { isSafeName } from "../git/guard.ts";

const API = "/api/v1/repos/";

/** The owner/name a path names, its prefix and the rest; undefined when it names none. */
function repoPath(pathname: string): { prefix: string; owner: string; name: string; git: boolean; rest: string } | undefined {
  const prefix = pathname.startsWith(API) ? API : "/";
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length < 2) return undefined;
  const [owner, raw] = parts as [string, string];
  const git = prefix === "/" && raw.endsWith(".git");
  const name = git ? raw.slice(0, -4) : raw;
  if (!isSafeName(owner) || !isSafeName(name)) return undefined;
  return { prefix, owner, name, git, rest: parts.slice(2).join("/") };
}

/** A push: the receive-pack advertisement or its POST. A push is refused, never carried over. */
function isPush(url: URL, rest: string): boolean {
  return rest === "git-receive-pack" || (rest === "info/refs" && url.searchParams.get("service") === "git-receive-pack");
}

/** The repository an old path names, when a move left that path behind; whoever asks. */
export function movedTarget(db: Database, url: URL): Repo | undefined {
  const at = repoPath(url.pathname);
  return at === undefined ? undefined : redirectFor(db, at.owner, at.name);
}

export function movedResponse(db: Database, url: URL, user: User | undefined): Response | undefined {
  const at = repoPath(url.pathname);
  if (at === undefined) return undefined;
  const repo = redirectFor(db, at.owner, at.name);
  if (repo === undefined || !canRead(db, repo, user)) return undefined;
  // Git's smart HTTP names the repository `name.git`; the new path keeps it.
  const suffix = at.git ? ".git" : "";
  if (at.git && isPush(url, at.rest)) {
    const path = `${repo.ownerName}/${repo.name}`;
    return new Response(
      `This repository moved to ${path}. Nothing was pushed: set the remote with git remote set-url origin ${url.origin}/${path}.git and push again.\n`,
      { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  const rest = at.rest === "" && !url.pathname.endsWith("/") ? "" : `/${at.rest}`;
  const location = `${at.prefix}${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}${suffix}${rest}${url.search}`;
  return new Response(null, { status: 308, headers: { location } });
}
