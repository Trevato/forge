import { ITEM_ID, recordInteraction } from "../../../core/interactions.ts";
import { interactionTarget } from "../../../feed/interact.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "feed_dismiss",
  doc: "`{ item, kind, app? }`: dismiss a feed item or mute its app, as the card's menu does (`kind` dismissed or muted); `feed` then leaves it out; `app` (`owner/name`) names the app for an item that is not an event; answers `{ id }`",
  description: "Dismiss a feed item or mute its app; `feed` then leaves it out.",
  inputSchema: {
    type: "object",
    properties: {
      item: { type: "string" },
      kind: { type: "string", enum: ["dismissed", "muted"] },
      app: { type: "string" },
    },
    required: ["item", "kind"],
  },
  writes: true,
  run(ctx, user, args) {
    const item = str(args["item"]);
    const kind = args["kind"];
    if (!ITEM_ID.test(item)) return bad("invalid", "item is a feed item id");
    if (kind !== "dismissed" && kind !== "muted")
      return bad("invalid", "kind is dismissed or muted");
    const target = interactionTarget(ctx.app.db, user, item, str(args["app"]));
    if (!target) return bad("not_found", "no such item");
    const made = recordInteraction(ctx.app.db, {
      viewerId: user.id,
      itemId: item,
      kind,
      repoId: target.repoId,
      actorId: target.actorId,
    });
    return good({ id: made.id });
  },
};
