import { budgetsOf, listSubscriptions, scopesOf } from "../../../core/subscriptions.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "subscriptions",
  doc: "the Claude accounts the crew works on: id (the handle `subscription_wake`, `subscription_budget` and `subscription_delete` take), name, kind, the repositories and organizations each pays for, budget and spend, and whether it is resting; never a token. A forge admin's",
  description: "Claude accounts: scopes, budgets.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  adminOnly: true,
  run(ctx) {
    const scopes = scopesOf(ctx.app.db);
    const budgets = budgetsOf(ctx.app.db);
    return good({
      items: listSubscriptions(ctx.app.db).map((s) => {
        const b = budgets.get(s.id);
        return {
          id: s.id,
          name: s.name,
          kind: s.kind,
          apiBase: s.apiBase,
          scopes: scopes.get(s.id) ?? [],
          budgetUsd: b?.budgetUsd ?? null,
          spentUsd: b?.spentUsd ?? 0,
          restingUntil: s.restingUntil,
          restingSaid: s.restingSaid,
          lastUsedAt: s.lastUsedAt,
        };
      }),
    });
  },
};
