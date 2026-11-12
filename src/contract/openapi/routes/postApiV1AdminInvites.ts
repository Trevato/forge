import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/invites",
  summary:
    "Mint an invite link (admin scope); answers 201 with the invite and its `token` and `link`: the link is shown once, here, and cannot be read again, so keep it",
  auth: true,
  role: "admin",
  status: 201,
  body: { days: "integer" },
  refusals: { invalid: "`days` is not a whole number from 1 to 30 (422)" },
};
