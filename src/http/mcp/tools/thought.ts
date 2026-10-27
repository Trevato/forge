import { placementJson, placementOf, thoughtAuthor } from "../../../core/placements.ts";
import { linksFrom, linksTo } from "../../../core/thought_links.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "thought",
  doc: "`{ id }`: where one of your thoughts went (its id comes from `tell` without a repo): the placement, and the earlier thoughts it repeats or takes back and the later ones that did the same; not yours and not there answer alike, `not_found`",
  description:
    "Where a thought went, by its id (from `tell` without a repo).",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", maxLength: 64 } },
    required: ["id"],
  },
  writes: false,
  run(ctx, user, args) {
    const thoughtId = args["id"];
    if (typeof thoughtId !== "string" || thoughtId === "")
      return bad("invalid", "id is a thought id");
    // Not yours and not there answer alike (a thought belongs to its author).
    if (thoughtAuthor(ctx.app.db, thoughtId) !== user.id)
      return bad("not_found", "no such thought");
    const links = linksFrom(ctx.app.db, thoughtId);
    const back = linksTo(ctx.app.db, thoughtId);
    return good({
      id: thoughtId,
      placement: placementJson(placementOf(ctx.app.db, thoughtId)),
      // The earlier thoughts this one repeats or takes back, and the later one that took it back.
      repeats: links.repeats,
      supersedes: links.supersedes,
      supersededBy: back.supersededBy,
      repeatedBy: back.repeatedBy,
    });
  },
};
