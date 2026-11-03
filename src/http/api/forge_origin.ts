/**
 * What another forge needs to connect to this one as an origin
 * (`docs/features/forge-origin.md`). Origins speak the Gitea dialect, so a
 * forge answers the few calls connecting needs in that dialect rather than
 * growing a fourth adapter: `GET /api/v1/version` (how `discover` recognises
 * it), and the Gitea shape of a repository, listed at `GET /api/v1/user/repos`
 * and nowhere else.
 *
 * Nothing here is new authority. The list is the caller's own repositories
 * through the same visibility rule as every other read, and a private one is
 * only ever seen by the token that may see it.
 */

import { listReposByOwner, visibleReposMarker, type Repo } from "../../core/repos.ts";
import type { Ctx, Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { json, unauthorized } from "../respond.ts";
import type { Router } from "../router.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";

/** The Gitea API generation this answers: the calls above, and no more. */
export const FORGE_API_VERSION = "1.0.0";

const PAGE_MAX = 100;
const OWNED_MAX = 1000;

/** A repository in the shape a Gitea-speaking client reads. */
export function giteaShape(ctx: Ctx, repo: Repo) {
  const full = `${repo.ownerName}/${repo.name}`;
  const web = `${ctx.url.origin}/${full}`;
  const mine = ctx.auth.user?.id === repo.ownerId;
  return {
    id: repo.id,
    full_name: full,
    name: repo.name,
    owner: { login: repo.ownerName },
    description: repo.description,
    private: repo.visibility === "private",
    fork: repo.forkParentId !== null,
    default_branch: repo.defaultBranch,
    clone_url: `${web}.git`,
    html_url: web,
    permissions: { push: mine, admin: mine },
  };
}

/** A positive integer from the query, or the fallback. */
function whole(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function forgeOriginRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/version", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    return timePhase(ctx.request, "render", () => {
      // The same body for everyone, so the tag is derived from it alone.
      const text = JSON.stringify({ version: FORGE_API_VERSION, software: "forge" });
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "no-cache" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
  });

  // The signed-in account's own repositories, `page` and `limit` as Gitea
  // pages them. Owned repositories are few; they are read whole (bounded) and
  // sliced, which keeps the page numbers honest.
  router.add("GET", "/api/v1/user/repos", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const me = ctx.auth.user;
    if (!me) return unauthorized();
    const limit = whole(ctx.url.searchParams.get("limit"), 50, PAGE_MAX);
    const page = whole(ctx.url.searchParams.get("page"), 1, OWNED_MAX);
    const owned: Repo[] = [];
    let cursor: string | undefined;
    // Pushes and open-issue counts are not in the body, so the tag also digests
    // what moves them, batch by batch, for the viewer's own listing.
    const markers: string[] = [];
    timePhase(ctx.request, "repos", () => {
      while (owned.length < OWNED_MAX) {
        const batch = listReposByOwner(ctx.app.db, me.username, me, {
          limit: PAGE_MAX,
          ...(cursor === undefined ? {} : { cursor }),
        });
        owned.push(...batch);
        markers.push(
          visibleReposMarker(ctx.app.db, me, {
            owner: me.username,
            limit: PAGE_MAX,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        if (batch.length < PAGE_MAX) break;
        cursor = batch[batch.length - 1]!.id;
      }
    });
    const start = (page - 1) * limit;
    const rows = owned.slice(start, start + limit).map((r) => giteaShape(ctx, r));
    const headers: Record<string, string> = {
      "x-total-count": String(owned.length),
    };
    if (start + limit < owned.length) {
      const next = new URL(ctx.url);
      next.searchParams.set("page", String(page + 1));
      next.searchParams.set("limit", String(limit));
      headers.link = `<${next.toString()}>; rel="next"`;
    }
    return timePhase(ctx.request, "render", () => {
      const body = JSON.stringify(rows);
      const etag = weakEtag(`${me.id}|${page}|${limit}|${markers.join(",")}|${body}`);
      const tagged = {
        ...headers,
        etag,
        "cache-control": "private, no-cache",
        vary: "authorization, cookie",
      };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers: tagged });
      return json(rows, 200, tagged);
    });
  });
}
