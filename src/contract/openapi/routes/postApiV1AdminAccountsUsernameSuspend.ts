import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/accounts/{username}/suspend",
  summary: "Suspend an account, undone by unsuspend (admin scope); answers { username, suspendedAt }",
  auth: true,
  role: "admin",
  body: { confirm: "boolean" },
  refusals: {
    not_allowed: "an admin cannot suspend themselves, another admin or an agent (422)",
    last_owner: "the person is the only active owner of an organization; send confirm true to suspend anyway (409)",
  },
};
