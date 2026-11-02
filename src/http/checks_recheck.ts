/**
 * The admin's one call to re-check every open pull red on one named test.
 */

import { RECHECK_MAX, recheckNamed, TEST_NAME_MAX } from "../checks/recheck.ts";
import { canAdmin, getRepo } from "../core/repos.ts";
import type { Handler } from "./context.ts";
import { apiError, body, json, notFound, requireScope, str } from "./respond.ts";
import type { Router } from "./router.ts";

export function checksRecheckRoutes(router: Router<Handler>): void {
  router.add("POST", "/api/v1/repos/:owner/:name/checks/recheck", async (ctx) => {
    const denied = requireScope(ctx, "admin");
    if (denied) return denied;
    const repo = getRepo(ctx.app.db, ctx.params.owner!, ctx.params.name!);
    if (!repo || !canAdmin(ctx.app.db, repo, ctx.auth.user)) return notFound();
    const test = str((await body(ctx.request)).test);
    if (test.length < 1 || test.length > TEST_NAME_MAX)
      return apiError("invalid_test", 400, `test is a name of 1 to ${TEST_NAME_MAX} characters`);
    const done = await recheckNamed(ctx.app, ctx.auth.user!, repo, test);
    return json(
      done.left > 0
        ? { queued: done.queued, more: done.left, message: `at most ${RECHECK_MAX} per call; ${done.left} left` }
        : { queued: done.queued },
      200,
    );
  });
}
