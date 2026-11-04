/**
 * A repository's upstream and forks over the API: `GET` and `PUT`
 * `/api/v1/repos/:owner/:name/upstream`, `POST …/upstream/check`, and `GET`
 * and `POST` `/api/v1/repos/:owner/:name/forks`. Moved out of `api.ts`
 * (#6305); the rules live in `actions/upstream_follow.ts` and
 * `actions/repos.ts`.
 */

import { forkRepo, FORKS_PER_DAY, repositoryLimitMessage } from "../../actions/repos.ts";
import {
  checkUpstreamNow,
  FOLLOW_REFUSALS,
  followJson,
  setFollowUpstream,
} from "../../actions/upstream_follow.ts";
import { ENABLED_WORDS } from "../../core/arg_words.ts";
import { driftOfForks, MAX_RANKED_FORKS, type RankedFork } from "../../actions/forks.ts";
import { canAdmin, forkParentFor, visibleForks } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { storageLimitMessage } from "../../core/storage.ts";
import { getFollow } from "../../core/upstream_follow.ts";
import { holds, weakEtag } from "../etag.ts";
import { loadRepo, pageParams, slicePage } from "../api.ts";
import type { Handler } from "../context.ts";
import { apiError, body, json, notFound, requireScope, respondAccess, str } from "../respond.ts";
import type { Router } from "../router.ts";

export function upstreamRoutes(router: Router<Handler>): void {
  // Following an outside upstream (#3442): an admin reads, sets and checks.
  router.add("GET", "/api/v1/repos/:owner/:name/upstream", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = requireScope(ctx, "ro");
    if (denied) return denied;
    const read = timePhase(ctx.request, "upstream", () => {
      const repo = loadRepo(ctx);
      if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return undefined;
      return getFollow(ctx.app.db, repo.id) ?? null;
    });
    if (read === undefined) return notFound();
    // The tag is of the exact bytes sent, and only after the access check above: a refusal carries none.
    return timePhase(ctx.request, "render", () => {
      const text = JSON.stringify({ following: read === null ? null : followJson(read) });
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
  });

  router.add("PUT", "/api/v1/repos/:owner/:name/upstream", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const input = await body(ctx.request);
    if (typeof input.enabled !== "boolean")
      return apiError("bad_enabled", 422, ENABLED_WORDS);
    const saved = setFollowUpstream(ctx.app, ctx.auth.user, repo, {
      url: str(input.url),
      branch: str(input.branch),
      enabled: input.enabled,
    });
    if (!saved.ok)
      return saved.error === "not_found" || saved.error === "unauthorized" || saved.error === "forbidden"
        ? respondAccess(saved.error, 422)
        : apiError(saved.error, 422, FOLLOW_REFUSALS[saved.error]);
    return json({ following: followJson(saved.value) });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/upstream/check", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const checked = await checkUpstreamNow(ctx.app, ctx.auth.user, repo);
    if (!checked.ok)
      return checked.error === "not_found" || checked.error === "unauthorized" || checked.error === "forbidden"
        ? respondAccess(checked.error, 422)
        : apiError(checked.error, checked.error === "busy" ? 409 : 422, FOLLOW_REFUSALS[checked.error]);
    return json(checked.value);
  });

  router.add("GET", "/api/v1/repos/:owner/:name/forks", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const page = pageParams(ctx);
    if (page instanceof Response) return page;
    const rows = timePhase(ctx.request, "forks", () => visibleForks(ctx.app.db, repo.id, ctx.auth.user));
    const sliced = slicePage(rows, page);
    if (sliced instanceof Response) return sliced;
    const { items, next_cursor } = sliced;
    // Drift is read for this page only, in runs of what one call ranks.
    const drifts = await timePhaseAsync(ctx.request, "drift", async () => {
      const ranked: RankedFork[] = [];
      for (let i = 0; i < items.length; i += MAX_RANKED_FORKS)
        ranked.push(...(await driftOfForks(ctx.app, repo, items.slice(i, i + MAX_RANKED_FORKS))));
      return ranked;
    });
    const parent = forkParentFor(ctx.app.db, repo, ctx.auth.user);
    // The tag is of the exact bytes sent: a fork made, pushed or hidden, or a parent that moved, changes
    // the body; limit and cursor choose the page. A 404 or bad page returned above carries none.
    return timePhase(ctx.request, "render", () => {
      const text = JSON.stringify({
        parent: parent === undefined ? null : `${parent.ownerName}/${parent.name}`,
        items: drifts.map(({ fork, drift, pushedAt }) => ({
          ...fork,
          ahead: drift.ahead,
          behind: drift.behind,
          updatedAt: pushedAt,
        })),
        next_cursor,
      });
      const etag = weakEtag(text);
      const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
      if (holds(ctx.request, etag)) return new Response(null, { status: 304, headers });
      return new Response(text, { headers: { "content-type": "application/json", ...headers } });
    });
  });

  router.add("POST", "/api/v1/repos/:owner/:name/forks", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const parent = loadRepo(ctx);
    if (!parent) return notFound();
    const input = await body(ctx.request);
    const forked = await forkRepo(
      ctx.app,
      ctx.auth.user,
      parent,
      str(input.name) || undefined,
    );
    if (!forked.ok)
      return forked.error === "repository_limit"
        ? apiError("repository_limit", 403, repositoryLimitMessage(ctx.app, ctx.auth.user!))
        : forked.error === "storage_limit"
        ? apiError("storage_limit", 403, storageLimitMessage(ctx.app, ctx.auth.user!.id))
        : forked.error === "limit"
        ? apiError("limit", 429, `at most ${FORKS_PER_DAY} forks a day: try again tomorrow`)
        : forked.error === "fork_failed"
        ? apiError("fork_failed", 422, "the fork could not be created")
        : respondAccess(forked.error, 422);
    return json(forked.value, 201);
  });
}
