import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/cloud/accounts",
  summary: "The forge's cloud accounts, each attached provider token with its use, verification, write permission and today's calls, never a secret; a forge administrator's, with a token that may write",
  auth: true,
  refusals: {
    forbidden: "a read-only token cannot list cloud accounts",
    not_found: "only a forge administrator sees this route",
  },
};
