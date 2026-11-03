/**
 * A pin's screenshots, read: one picture by name, to whoever reads the
 * repository (`git/shots.ts`). They are written through the API and the
 * terminal (`actions/build_shots.ts`); there is no gallery page yet.
 */

import { readShotBytes } from "../../git/shots.ts";
import { repoDir } from "../../git/repos.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage } from "../chrome.ts";

// GET /:owner/:name/builds/:label/shots/:file — one screenshot. Typed by
// its first bytes, never by its name, and never sniffed into anything else.
export async function shotImage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  const shot = await timePhase(ctx.request, "read", () => readShotBytes(dir, ctx.params.label ?? "", ctx.params.file ?? ""));
  if (shot === undefined) return notFoundPage(ctx);
  // A name moves to another picture on a reorder; the blob it is does not.
  const etag = `"${shot.oid}"`;
  const headers = {
    "content-type": shot.type,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    etag,
    "cache-control":
      ctx.url.searchParams.get("v") === shot.oid.slice(0, 12) ? "private, max-age=31536000, immutable" : "private, no-cache",
  };
  if (ctx.request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(shot.bytes, { headers });
}
