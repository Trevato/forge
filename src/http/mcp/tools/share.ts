import { ITEM_ID } from "../../../core/interactions.ts";
import { share } from "../../../feed/share.ts";
import { parseTargets } from "../../feed.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "share",
  doc: "`{ item, to? }`: share a feed item (`item` is its id); with no `to` it goes to the app's crew and owners, else to up to 10 named usernames' followers; a daily budget each; answers `{ sent }`",
  description:
    "Share a feed item: no `to` tells the app's crew and owners, else followers; budgeted.",
  inputSchema: {
    type: "object",
    properties: {
      item: { type: "string" },
      to: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
      },
    },
    required: ["item"],
  },
  writes: true,
  async run(ctx, user, args) {
    const item = str(args["item"]);
    const to = parseTargets(args["to"]);
    if (!ITEM_ID.test(item) || to === undefined)
      return bad("invalid", "item is a feed item id; to is up to 10 usernames");
    const made = await share(ctx.app, user, item, to);
    if (!made.ok) return bad("not_found", "no such item");
    return good({ sent: made.value.sent });
  },
};
