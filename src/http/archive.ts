/**
 * `GET /:owner/:name/archive/<ref>.tar.gz`: the source at a commit, for an
 * agent that has HTTPS and no git. Anyone who may read the repository may
 * take it; a private one answers 404 like every other page. At a full commit
 * id the bytes never change and are cached as such.
 */

import { getRepo, canRead } from "../core/repos.ts";
import { archiveAt } from "../git/archive.ts";
import { ARCHIVE_HTTP_BYTES, takeArchive } from "./archive_limit.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import type { Handler } from "./context.ts";
import { securityFloor } from "./respond.ts";

const FULL_OID = /^[0-9a-f]{40}$/;
const SUFFIX = ".tar.gz";

export const sourceArchive: Handler = async (ctx) => {
  const gone = () => securityFloor(new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }));
  const repo = getRepo(ctx.app.db, ctx.params.owner ?? "", (ctx.params.name ?? "").replace(/\.git$/, ""));
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return gone();
  const file = ctx.params.file ?? "";
  if (!file.endsWith(SUFFIX)) return gone();
  const ref = file.slice(0, -SUFFIX.length);
  if (!isSafeRef(ref) && !FULL_OID.test(ref)) return gone();
  const path = new URL(ctx.request.url).searchParams.get("path") ?? undefined;
  if (path !== undefined && !isSafeTreePath(path)) return gone();
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const turn = takeArchive(ctx.request);
  if (!turn.ok)
    return securityFloor(
      new Response(turn.why === "rate" ? "too many archives from this address: wait a minute\n" : "busy: try again shortly\n", {
        status: turn.why === "rate" ? 429 : 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": String(turn.retryAfter) },
      }),
    );
  const made = await archiveAt(dir, ref, `${repo.name}-${ref.slice(0, 12)}`, path, ARCHIVE_HTTP_BYTES).finally(turn.done);
  if (!made.ok)
    return securityFloor(
      new Response(made.error === "too_large" ? "too large to archive: use git\n" : "not found\n", {
        status: made.error === "too_large" ? 413 : 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  const pinned = FULL_OID.test(ref) && repo.visibility === "public";
  return securityFloor(
    new Response(made.value.bytes, {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${repo.name}-${made.value.oid.slice(0, 12)}.tar.gz"`,
        "x-forge-commit": made.value.oid,
        "cache-control": pinned ? "public, max-age=31536000, immutable" : "no-cache",
        etag: `"${made.value.oid}"`,
      },
    }),
  );
};
