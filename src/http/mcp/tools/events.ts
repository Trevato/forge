import { EVENTS_LIMIT_MAX, eventsLimit, eventsPage, validEventsCursor, validEventsKind } from "../../../core/events_page.ts";
import { CURSOR_NOT_ISSUED } from "../../../actions/feed_words.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "events",
  doc: "`{ repo, kind?, limit?, cursor? }`: the repository's events (of one `kind`, e.g. `repo.settings_updated`, when given), newest first, as you may see them (a webhook's URL and an app's variable names are the admins'): `{ items, next_cursor }`, `limit` 1 to 200 (default 50), `cursor` from `next_cursor`",
  description: "Repository events.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      kind: { type: "string" },
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
    const kind = args["kind"];
    if (kind !== undefined && (typeof kind !== "string" || !validEventsKind(kind)))
      return bad("invalid", "kind is an event kind, like repo.settings_updated");
    return good(eventsPage(ctx.app.db, repo.id, user, limit, given, kind));
  },
};
