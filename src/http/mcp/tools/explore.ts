import { explorePage, exploreLine, exploreNote, exploreSuggestion, readExploreLine } from "../../../actions/explore.ts";
import { bad, good, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "explore",
  doc: "`{ q?, cursor? }` (`query` is the same, `q` wins): the apps and people you can see, ranked, with their numbers; `kind:` `sort:` `updated:` `owner:` `archived:` and words in one line; page on with `cursor`",
  description:
    "The apps, people (and, for an admin, forges) you can see, ranked.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        maxLength: 200,
        description: "Words; kind: sort: updated:7d owner: archived:",
      },
      query: {
        type: "string",
        maxLength: 200,
        description: "Alias of q",
      },
      cursor: {
        type: "string",
      },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    const q = str(args["q"]);
    const line = q !== "" ? q : str(args["query"]);
    const { query, unknown } = readExploreLine(line);
    const suggest = exploreSuggestion(line);
    const cursor = str(args["cursor"]);
    const page = await explorePage(ctx.app, user, query, cursor === "" ? null : cursor);
    if (page === null) return bad("invalid_cursor", "cursor is not the next_cursor of a page before");
    return good({
      query: exploreLine(query),
      ...(unknown.length === 0 ? {} : { note: exploreNote(unknown) }),
      ...(suggest === undefined ? {} : { suggest: suggest.line }),
      items: page.items,
      next_cursor: page.nextCursor,
    });
  },
};
