/**
 * Take it back over the API: `POST /api/v1/repos/:owner/:name/pulls/:number/take-back`
 * opens the pull that undoes a shipped one, as the page's Take back does
 * (`web/studio/actions.ts` `takeBackSubmit`). This is a door only: the
 * rules live in `actions/revert.ts`; this says each refusal as one stable
 * code and status. A refusal of the request is 403/404/409; a failure of
 * the forge's own git is 500 `git_failed`, with git's words kept in the
 * log — they can name paths on the server's disk — and never sent.
 */

/** What a client is told when the forge's own git failed: nothing to fix on its side. */
const GIT_FAILED = "the forge could not build the revert; nothing was changed";

import { revertPull, type RevertPullError } from "../../actions/revert.ts";
import { loadPull, withLabels } from "../api.ts";
import type { Log } from "../../kernel/log.ts";
import type { Handler } from "../context.ts";
import { apiError, json, requireScope, respondAccess } from "../respond.ts";
import type { Router } from "../router.ts";
import { variantSiblings } from "../../core/pulls.ts";

/** A refused take-back as the API says it: one code and status per refusal. */
export function takeBackRefusal(error: RevertPullError, log: Log): Response {
  if (typeof error === "string") {
    switch (error) {
      case "not_shipped":
        return apiError("not_shipped", 409, "only a shipped pull can be taken back");
      case "already_reverted":
        return apiError("already_reverted", 409, "this pull has already been taken back");
      case "mirrored":
        return apiError(
          "mirrored",
          409,
          "this repository mirrors an origin; take it back there and the next sync will reflect it",
        );
      case "forbidden":
        return apiError("forbidden", 403, "only a person who can write here can take a pull back");
      default:
        return respondAccess(error, 403);
    }
  }
  switch (error.kind) {
    case "conflict":
      return apiError(
        "conflict",
        409,
        `it conflicts with the current code in ${error.files.join(", ")}`,
      );
    case "base_moved":
      return apiError("conflict", 409, "the default branch moved under it; try again");
    case "octopus":
      return apiError("conflict", 409, `it has ${error.parents} parents; take it back by hand`);
    case "unsafe":
      log.error("take-back: an unsafe oid reached git");
      return apiError("git_failed", 500, GIT_FAILED);
    case "git":
      log.error("take-back: git failed", { message: error.message });
      return apiError("git_failed", 500, GIT_FAILED);
    case "branch_failed":
    case "pull_failed":
      log.error(`take-back: ${error.kind}`, { reason: error.reason });
      return apiError("git_failed", 500, GIT_FAILED);
  }
}

export function takeBackRoutes(router: Router<Handler>): void {
  router.add(
    "POST",
    "/api/v1/repos/:owner/:name/pulls/:number/take-back",
    async (ctx) => {
      const denied = requireScope(ctx, "rw");
      if (denied) return denied;
      const found = loadPull(ctx);
      if ("error" in found) return found.error;
      const reverted = await revertPull(ctx.app, ctx.auth.user, found.repo, found.pull);
      if (!reverted.ok) return takeBackRefusal(reverted.error, ctx.app.log);
      return json(
        {
          ...withLabels(ctx, reverted.value),
          variantSiblings: variantSiblings(ctx.app.db, [reverted.value])[0] ?? [],
        },
        201,
      );
    },
  );
}
