import { budgetRefusal, setBudget } from "../../../core/subscriptions.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "subscription_budget",
  doc: "`{ id, usd }`: set an account's whole-life budget in dollars (up to the `subscription.budget_max_usd` limit), or clear it with `usd: null`, as the Subscriptions page does; a locked budget can only be lowered; a forge admin with an admin token",
  description: "Admin: set an account's lifetime USD budget; null clears.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, usd: { type: ["number", "null"] } },
    required: ["id", "usd"],
  },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  run(ctx, _user, args) {
    const id = args["id"];
    const usd = args["usd"];
    if (typeof id !== "string" || id === "" || id.length > 64)
      return bad("invalid", "id is the account's id");
    if (usd !== null && (typeof usd !== "number" || !Number.isFinite(usd)))
      return bad("invalid", "usd is a number of dollars, or null to clear");
    const refused = budgetRefusal(ctx.app.db, id, usd);
    if (refused) return bad(refused.code, refused.says);
    if (!setBudget(ctx.app.db, id, usd)) return bad("invalid", "The budget was not saved.");
    const budgetUsd = usd === null ? null : Math.round(usd * 100) / 100;
    return good({
      id,
      budgetUsd,
      says: budgetUsd === null ? "No budget: this account spends until you stop it." : `Budget set: $${budgetUsd} in all.`,
    });
  },
};
