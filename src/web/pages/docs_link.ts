/**
 * /docs and /docs/NAME.md: the way into the forge's own documentation.
 * The target is built from configuration alone (the own repository's path
 * and the upstream named in llms.txt), never from the request: only NAME,
 * checked against `[A-Za-z0-9_-]+`, is spliced in, so there is no open
 * redirect. A public own repository answers with a same-origin path;
 * otherwise the same folder on the upstream.
 */

import type { Database } from "bun:sqlite";
import { getRepo } from "../../core/repos.ts";
import { ownRepoPath } from "../../kernel/own_repo.ts";
import type { Ctx } from "../../http/context.ts";
import { notFound } from "../../http/respond.ts";
import { UPSTREAM_REPO as UPSTREAM } from "../../core/upstream.ts";

const NAME = /^[A-Za-z0-9_-]+$/;

/** Where the docs live for this forge: a path here, or the upstream's URL. */
export function docsBase(db: Database, kind: "tree" | "blob"): string {
  const [owner = "", name = ""] = ownRepoPath().split("/");
  const repo = owner === "" || name === "" ? undefined : getRepo(db, owner, name);
  if (repo !== undefined && repo.visibility === "public")
    return `/${repo.ownerName}/${repo.name}/${kind}/${encodeURIComponent(repo.defaultBranch)}/docs`;
  return `${UPSTREAM}/${kind}/main/docs`;
}

/** The target for the folder (`file` absent) or one file; undefined for a bad NAME. */
export function docsTarget(db: Database, file?: string): string | undefined {
  if (file === undefined) return docsBase(db, "tree");
  if (!file.endsWith(".md") || !NAME.test(file.slice(0, -3))) return undefined;
  return `${docsBase(db, "blob")}/${file}`;
}

const go = (to: string): Response =>
  new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });

export function docsFolder(ctx: Ctx): Response {
  return go(docsBase(ctx.app.db, "tree"));
}

export function docsFile(ctx: Ctx): Response {
  const to = docsTarget(ctx.app.db, ctx.params.file);
  return to === undefined ? notFound() : go(to);
}
