/**
 * A fork's standing against its parent over the API: the
 * `/api/v1/repos/:owner/:name/following` routes and `PATCH
 * /api/v1/forge/following`. Moved out of `api.ts` (#6328); the rules live in
 * `actions/follow.ts` and `crew/converge.ts`.
 */

import { FAMILY_WORDS } from "../../actions/family_words.ts";
import { FOLLOW_MODE_REFUSALS, setFollowMode, severForge, takeForgeCode, takeForgeWords } from "../../actions/follow.ts";
import { relationOf } from "../../actions/forks.ts";
import { forgeProposals, proposeToParentForge, proposeUpstream } from "../../actions/upstream.ts";
import { parentForgeFor } from "../../core/parent_releases.ts";
import { forkParentFor, getRepo } from "../../core/repos.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { convergeFork, convergeState } from "../../crew/converge.ts";
import { mayDirectCrew } from "../../crew/direct.ts";
import { chainOfRepo, forgeLinkOf } from "../../spawn/chain.ts";
import { upstreamPayload } from "../../spawn/upstream.ts";
import { loadRepo, respondTake } from "../api.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { apiError, body, json, notFound, requireScope, respondAccess, tryAgain, untilNextDay } from "../respond.ts";
import type { Router } from "../router.ts";

/**
 * A body tagged by its own bytes (the standing, or the proposals to the parent): a push to the fork or to the parent's
 * default branch, or a severed chain, changes them, and a viewer who cannot see
 * the parent is rendered a different body, so never shares a tag with one who can.
 */
function tagged(request: Request, payload: unknown): Response {
  const text = JSON.stringify(payload);
  const etag = weakEtag(text);
  const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
  if (holds(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers: { "content-type": "application/json", ...headers } });
}

export function followingRoutes(router: Router<Handler>): void {
  // ── following. A fork's standing against its parent, read from git each
  // time; taking updates is git's part, converging is the crew's.
  router.add("GET", "/api/v1/repos/:owner/:name/following", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const relation = await timePhaseAsync(ctx.request, "relation", () =>
      relationOf(ctx.app, ctx.auth.user, repo),
    );
    const chain = await timePhaseAsync(ctx.request, "chain", () => chainOfRepo(ctx.app, repo));
    if (relation === undefined) {
      if (chain === undefined) return apiError("not_a_fork", 404, "this repository follows nothing");
      const upstream = await timePhaseAsync(ctx.request, "upstream", () => upstreamPayload(ctx.app));
      return timePhase(ctx.request, "render", () =>
        tagged(ctx.request, { chain: chain.lines, severedAt: chain.severedAt, upstream }),
      );
    }
    const converge =
      relation.state === "diverged" && !relation.clean
        ? timePhase(ctx.request, "converge", () => convergeState(ctx.app, repo, relation.parent))
        : undefined;
    const upstream =
      chain === undefined
        ? null
        : await timePhaseAsync(ctx.request, "upstream", () => upstreamPayload(ctx.app));
    return timePhase(ctx.request, "render", () => tagged(ctx.request, {
      chain: chain?.lines ?? null,
      severedAt: chain?.severedAt ?? null,
      upstream,
      parent: `${relation.parent.ownerName}/${relation.parent.name}`,
      parentBranch: relation.parent.defaultBranch,
      // A parent whose origin was disconnected: the counts below are against
      // where it froze, never against its upstream (#1090).
      parentFrozen:
        relation.parent.detached === null
          ? null
          : {
              detachedAt: relation.parent.detached.detachedAt,
              frozenSince: relation.parent.detached.frozenSince,
            },
      branch: repo.defaultBranch,
      state: relation.state,
      behind: relation.behind,
      ahead: relation.ahead,
      clean: relation.clean,
      conflicts: relation.conflicts,
      // The sync contract's one reconciling action and the words for it (src/git/sync_link.ts).
      action: relation.action,
      words: relation.words,
      forkTip: relation.forkTip,
      parentTip: relation.parentTip,
      parentForge: parentForgeFor(ctx.app.config),
      converge:
        converge === undefined
          ? null
          : {
              kind: converge.kind,
              issue: "issue" in converge ? converge.issue.number : null,
              pull: "pull" in converge ? converge.pull.number : null,
              agent:
                "agent" in converge && converge.agent !== undefined
                  ? converge.agent.user.username
                  : null,
            },
    }));
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/take",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      // The repository that carries this forge's code takes as a pull; any other fork merges.
      if ((await forgeLinkOf(ctx.app))?.repo !== `${repo.ownerName}/${repo.name}`) return respondTake(ctx, repo);
      const took = await takeForgeCode(ctx.app, ctx.auth.user, repo);
      if (!took.ok)
        return took.error === "not_following"
          ? apiError("not_following", 404, FAMILY_WORDS.not_following)
          : respondAccess(took.error, 403);
      return json({ ...took.value, ...takeForgeWords(took.value) });
    },
  );

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/sever",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const cut = await severForge(ctx.app, ctx.auth.user, repo);
      if (!cut.ok)
        return cut.error === "not_following"
          ? apiError("not_following", 404, FAMILY_WORDS.not_following)
          : respondAccess(cut.error, 403);
      return json({ severedAt: cut.value });
    },
  );

  // How this forge follows the forge its code came from: its own code
  // repository's admin only, the same words as the page and MCP.
  router.add("PATCH", "/api/v1/forge/following", async (ctx) => {
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const link = await forgeLinkOf(ctx.app);
    const [owner, name] = (link?.repo ?? "/").split("/") as [string, string];
    const repo = link === undefined ? undefined : getRepo(ctx.app.db, owner, name);
    if (repo === undefined) return apiError("not_following", 404, FOLLOW_MODE_REFUSALS.not_following.message);
    const set = await setFollowMode(ctx.app, ctx.auth.user, repo, (await body(ctx.request)).mode);
    if (set.ok) return json({ mode: set.value });
    const r = FOLLOW_MODE_REFUSALS[set.error];
    return apiError(set.error, r.status, r.message);
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/propose",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const proposed = await proposeUpstream(ctx.app, ctx.auth.user, repo);
      if (!proposed.ok) {
        const e = proposed.error;
        if (e === "not_a_fork")
          return apiError("not_a_fork", 404, "this repository follows nothing");
        if (e === "nothing_to_propose")
          return apiError(
            "nothing_to_propose",
            409,
            "nothing here is ahead of the parent",
          );
        if (typeof e === "string") return respondAccess(e, 403);
        return apiError("refused", 409, e.reason);
      }
      const { pull, opened, changes } = proposed.value;
      return json({ number: pull.number, opened, changes, title: pull.title });
    },
  );

  // Across forges: push this forge's change to the parent forge and open the
  // pull there; GET says how each proposal stands, as the parent last said.
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/propose-parent",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      const made = await proposeToParentForge(ctx.app, ctx.auth.user, repo);
      if (!made.ok) {
        const e = made.error;
        if (e === "no_parent_forge")
          return apiError("no_parent_forge", 404, "this repository has no parent forge to propose to");
        if (e === "nothing_to_propose")
          return apiError("nothing_to_propose", 409, FAMILY_WORDS.nothing_to_propose);
        if (typeof e === "string") return respondAccess(e, 403);
        return e.kind === "unreachable"
          ? apiError("parent_unreachable", 502, "parent unreachable")
          : apiError("refused", 409, e.reason);
      }
      return json(made.value, made.value.opened ? 201 : 200);
    },
  );

  router.add("GET", "/api/v1/repos/:owner/:name/following/proposals", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const items = await timePhaseAsync(ctx.request, "read", () =>
      forgeProposals(ctx.app, repo, Date.now(), ctx.auth.user !== undefined),
    );
    return timePhase(ctx.request, "render", () => tagged(ctx.request, { items }));
  });

  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/following/converge",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const repo = loadRepo(ctx);
      if (!repo) return notFound();
      if (!mayDirectCrew(ctx.app.db, repo, ctx.auth.user))
        return respondAccess("forbidden", 403);
      const parent = forkParentFor(ctx.app.db, repo, ctx.auth.user);
      if (parent === undefined)
        return apiError("not_a_fork", 404, "this repository follows nothing");
      const outcome = await convergeFork(ctx.app, repo, parent, ctx.auth.user);
      if (outcome.kind === "archived") return respondAccess("archived", 409);
      const status =
        outcome.kind === "queued"
          ? 202
          : outcome.kind === "working" || outcome.kind === "proposed"
            ? 200
            : outcome.kind === "ceiling"
              ? 429
              : outcome.kind === "nobody" || outcome.kind === "forbidden" || outcome.kind === "not_member"
                ? 403
                : 409;
      const payload = {
          kind: outcome.kind,
          issue: "issue" in outcome ? outcome.issue.number : null,
          pull: "pull" in outcome ? outcome.pull.number : null,
          agent:
            "agent" in outcome && outcome.agent !== undefined
              ? outcome.agent.user.username
              : null,
        };
      // The crew's ceiling is a day's spend: it starts over at the next UTC day.
      if (outcome.kind === "ceiling")
        return tryAgain("ceiling", 429, "the crew is at its ceiling for today", untilNextDay(), {}, payload);
      return json(payload, status);
    },
  );
}
