import { explore, exploreLine, parseExploreQuery } from "../../../actions/explore.ts";
import { good, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "explore",
  doc: "`{ query? }`: the apps and people you can see, ranked by forks, ships, use and freshness, with their numbers; `kind:` `sort:` and words in one line",
  description:
    "The apps, people (and for a site admin, spawned forges) you can see, ranked.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        maxLength: 200,
        description: "Words; kind: sort: updated:7d",
      },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    const query = parseExploreQuery(str(args["query"]));
    return good({
      query: exploreLine(query),
      items: await explore(ctx.app, user, query),
    });
  },
};
