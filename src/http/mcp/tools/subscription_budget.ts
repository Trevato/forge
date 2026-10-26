import { limitValue } from "../../../settings/limits.ts";
import { budgetsOf, setBudget } from "../../../core/subscriptions.ts";
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
    const held = budgetsOf(ctx.app.db).get(id);
    if (!held) return bad("not_found", "no such account");
    if (held.locked && (usd === null || !(usd < (held.budgetUsd ?? 0))))
      return bad(
        "locked",
        "This budget was set by whoever made this forge: it can be lowered, never raised or cleared.",
      );
    const max = limitValue(ctx.app.db, "subscription.budget_max_usd");
    if (!setBudget(ctx.app.db, id, usd))
      return bad("invalid", `A budget is dollars from 1 to ${max}, or null for none.`);
    const budgetUsd = usd === null ? null : Math.round(usd * 100) / 100;
    return good({
      id,
      budgetUsd,
      says: budgetUsd === null ? "No budget: this account spends until you stop it." : `Budget set: $${budgetUsd} in all.`,
    });
  },
};
