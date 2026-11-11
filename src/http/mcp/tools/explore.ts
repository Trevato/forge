import { explorePage, exploreLine, exploreLineFrom, EXPLORE_PARAMS, exploreNote, exploreSuggestion, readExploreLine } from "../../../actions/explore.ts";
import { forkTreeRows } from "../../../actions/fork_tree_rows.ts";
import { bad, good, type Tool, str, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "explore",
  doc: "`{ kind: tree, app }`: `{ app, upstream, forks, truncated }`, rows `{ repo, follows, standing, updatedAt }` for the app, the chain above it (nearest first) and its direct forks, in the words of the forks page, only what you may read; else `{ q?, cursor? }` (`query` is the same, `q` wins): the apps and people you can see, ranked, with their numbers; `kind:` `sort:` `updated:` `owner:` `archived:` and words in one line; each also as its own argument (`since` = `updated`); page on with `cursor`",
  description:
    "The apps, people (and, for an admin, forges) you can see, ranked.",
  inputSchema: {
    type: "object",
    properties: {
      q: {
        type: "string",
        maxLength: 200,
        description: "kind: sort: updated: owner: archived:. Unknown word: error",
      },
      query: {
        type: "string",
        maxLength: 200,
        description: "Alias of q",
      },
      ...Object.fromEntries(EXPLORE_PARAMS.map((k) => [k, { type: "string", maxLength: 100 }])),
      since: { type: "string", maxLength: 100 },
      app: { type: "string", maxLength: 200, description: "With kind: tree" },
      cursor: {
        type: "string",
      },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    if (str(args["kind"]) === "tree") {
      const repo = repoArg(ctx, user, { repo: args["app"] });
      return isAnswer(repo) ? repo : good(await forkTreeRows(ctx.app, repo, user));
    }
    const q = str(args["q"]);
    const line = exploreLineFrom((name) => (name === "q" ? (q !== "" ? q : str(args["query"])) : str(args[name])));
    const { query, unknown } = readExploreLine(line);
    const suggest = exploreSuggestion(line);
    if (unknown.length > 0) return bad("unknown_filter", exploreNote(unknown) + (suggest === undefined ? "" : `; did you mean "${suggest.line}"?`));
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
