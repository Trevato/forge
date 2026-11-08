import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/subscriptions",
  summary:
    "The crew's Claude accounts, as MCP `subscriptions` says it, never a token (a forge admin); answers { items: [{ id, name, kind, apiBase, scopes, budgetUsd, spentUsd, restingUntil, restingSaid, lastUsedAt }] }",
  auth: true,
  refusals: { not_admin: "the caller is not a forge admin (403)" },
};
