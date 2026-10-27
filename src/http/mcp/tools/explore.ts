import { explorePage, exploreLine, parseExploreQuery } from "../../../actions/explore.ts";
import { bad, good, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "explore",
  doc: "`{ query?, cursor? }`: the apps and people you can see, ranked, with their numbers; `kind:` `sort:` and words in one line; page on with `cursor`",
  description:
    "The apps, people (and, for an admin, forges) you can see, ranked.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 200,
        description: "Words; kind: sort: updated:7d",
      },
      cursor: {
        type: "string",
      },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    const query = parseExploreQuery(str(args["query"]));
    const cursor = str(args["cursor"]);
    const page = await explorePage(ctx.app, user, query, cursor === "" ? null : cursor);
    if (page === null) return bad("invalid_cursor", "cursor is not the next_cursor of a page before");
    return good({
      query: exploreLine(query),
      items: page.items,
      next_cursor: page.nextCursor,
    });
  },
};
