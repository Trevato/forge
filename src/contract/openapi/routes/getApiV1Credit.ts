import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/credit",
  summary:
    "On a forge its parent funds: the cap and the spend of the credit it was lent, asked of the parent afresh; answers { capUsd, spentUsd, says } (\"funded by its parent: $X of $200 left\"). 404 when no parent funds this forge",
  auth: true,
  role: "member",
  refusals: { not_found: "no parent funds this forge" },
};
