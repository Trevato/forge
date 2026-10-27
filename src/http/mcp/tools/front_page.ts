import { frontInput, frontJson, setFront } from "../../../actions/front.ts";
import { ADMIN_WORDS } from "../../../actions/admin_words.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "front_page",
  doc: "`{ pinned?, hidden?, weights?, dryRun? }`: the front page as a stranger sees it, ranked, with numbers; a site admin sets what is pinned (first public one featured), hidden, and what counts (weights of forks, ships, use, fresh, 0 to 10)",
  description:
    "The stranger's front page; admin sets `pinned`/`hidden`/`weights`.",
  inputSchema: {
    type: "object",
    properties: {
      pinned: { type: "array", items: { type: "string" } },
      hidden: { type: "array", items: { type: "string" } },
      weights: {
        type: "object",
        description: "0–10 each.",
        properties: {
          forks: { type: "number" },
          ships: { type: "number" },
          use: { type: "number" },
          fresh: { type: "number" },
        },
      },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    if (
      args["pinned"] === undefined &&
      args["hidden"] === undefined &&
      args["weights"] === undefined
    )
      return good(frontJson(ctx.app, user));
    const picks = frontInput(ctx.app, args);
    if (picks === undefined)
      return bad("invalid", "pinned and hidden are lists of owner/name; weights an object of forks, ships, use, fresh");
    const set = setFront(ctx.app, user, picks, args["dryRun"] !== false);
    if (!set.ok)
      return set.error.kind === "forbidden"
        ? bad("forbidden", ADMIN_WORDS.frontPage)
        : bad("invalid", set.error.message);
    return good({
      dryRun: args["dryRun"] !== false,
      picks: set.value,
      ...(args["dryRun"] === false ? { front: frontJson(ctx.app, user) } : {}),
    });
  },
};
