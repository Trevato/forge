import { deleteSubscription } from "../../../core/subscriptions.ts";
import { SUBSCRIPTION_WORDS } from "../../../core/subscriptions_words.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "subscription_delete",
  doc: "`{ id }`: remove a subscription and its grants, as the Subscriptions page does; runs it paid for keep it in their history; a forge admin's, with an admin token",
  description: "Remove a subscription, with its grants.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  run(ctx, _user, args) {
    const subscription = args["id"];
    if (typeof subscription !== "string" || subscription === "" || subscription.length > 64) return bad("invalid", "send the subscription's id");
    if (!deleteSubscription(ctx.app.db, subscription)) return bad("not_found", SUBSCRIPTION_WORDS.not_found);
    return good({ id: subscription, says: SUBSCRIPTION_WORDS.removed });
  },
};
