/**
 * A repository's display over the API: `PUT …/display/builds` chooses its
 * builds. The rules live in `actions/displays.ts`; this parses and shapes.
 */

import { chooseBuilds, parseChoice } from "../../actions/displays.ts";
import type { Handler } from "../context.ts";
import { loadRepo } from "../api.ts";
import { bodyCapFor, readBounded } from "../limits.ts";
import { apiError, forbidden, json, notFound, requireScope } from "../respond.ts";
import type { Router } from "../router.ts";

export function displayRoutes(router: Router<Handler>): void {
  router.add("PUT", "/api/v1/repos/:owner/:name/display/builds", async (ctx) => {
    // Sign-in and, for a browser's session, same-origin.
    const denied = requireScope(ctx, "rw");
    if (denied) return denied;
    const repo = loadRepo(ctx);
    if (!repo) return notFound();
    const bytes = await readBounded(ctx.request, bodyCapFor(ctx.request));
    if (bytes === "too_large") return apiError("too_large", 413, "that is too large to read here");
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return apiError("bad_json", 400, "the body must be JSON: { \"builds\": [\"owner/name:label\"] }");
    }
    const choice = parseChoice(input);
    if (!choice.ok) return apiError("invalid", 422, choice.error);
    const done = await chooseBuilds(ctx.app, ctx.auth.user, repo, choice.value.builds, choice.value.tip);
    if (done.ok) return json({ builds: done.value });
    switch (done.error.kind) {
      case "forbidden":
        return forbidden();
      case "no_display":
        return notFound();
      case "invalid":
        return apiError("invalid", 422, done.error.message);
      default:
        return apiError("failed", 409, done.error.message);
    }
  });
}
