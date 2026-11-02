import { subscriptionRows } from "../../../core/subscriptions.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "subscriptions",
  doc: "the Claude accounts the crew works on: id (the handle `subscription_wake`, `subscription_budget` and `subscription_delete` take), name, kind, the repositories and organizations each pays for, budget and spend, and whether it is resting; never a token. A forge admin's",
  description: "Claude accounts: scopes, budgets.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  adminOnly: true,
  run(ctx) {
    return good({ items: subscriptionRows(ctx.app.db) });
  },
};
