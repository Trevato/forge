import { recordInteraction } from "../../../core/interactions.ts";
import { readInteraction } from "../../../feed/interact.ts";
import { good, bad, type Tool } from "../shared.ts";

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
    const act = readInteraction(ctx.app.db, user, args, ["dismissed", "muted"]);
    if (!act.ok) return bad(act.error.code, act.error.message);
    const { itemId, kind, target } = act.value;
    const made = recordInteraction(ctx.app.db, {
      viewerId: user.id,
      itemId,
      kind,
      repoId: target.repoId,
      actorId: target.actorId,
    });
    return good({ id: made.id });
  },
};
