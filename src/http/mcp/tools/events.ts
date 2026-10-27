import { EVENTS_LIMIT_MAX, eventsLimit, eventsPage, validEventsCursor } from "../../../core/events_page.ts";
import { CURSOR_NOT_ISSUED } from "../../../actions/feed_words.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "events",
  doc: "`{ repo, limit?, cursor? }`: the repository's events, newest first, as you may see them (a webhook's URL and an app's variable names are the admins'): `{ items, next_cursor }`, `limit` 1 to 200 (default 50), `cursor` from `next_cursor`",
  description: "Repository events.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      limit: { type: "integer" },
      cursor: { type: "string" },
    },
    required: ["repo"],
  },
  writes: false,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const limit = eventsLimit(args["limit"]);
    if (limit === undefined) return bad("invalid", `limit is 1 to ${EVENTS_LIMIT_MAX}`);
    const given = args["cursor"];
    if (given !== undefined && (typeof given !== "string" || !validEventsCursor(given)))
      return bad("invalid", CURSOR_NOT_ISSUED);
    return good(eventsPage(ctx.app.db, repo.id, user, limit, given));
  },
};
