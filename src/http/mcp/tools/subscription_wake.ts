import { getSubscription, wakeSubscription } from "../../../core/subscriptions.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "subscription_wake",
  doc: "`{ id }`: use a resting Claude subscription again now, as the Subscriptions page's Wake button does; answers `{ id, says }`; a forge admin, an admin token",
  description: "Admin: wake a resting subscription.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  run(ctx, _user, args) {
    const id = args["id"];
    if (typeof id !== "string" || id === "" || id.length > 64)
      return bad("invalid", "id is the subscription's id");
    if (!getSubscription(ctx.app.db, id)) return bad("not_found", "no such subscription");
    wakeSubscription(ctx.app.db, id);
    return good({ id, says: "In use again." });
  },
};
