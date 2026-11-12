import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/admin/accounts/{username}",
  summary:
    "Remove an account for good (an admin's, admin scope); answers { removed }. With retireOrgs true and no confirm it answers { confirm_required, retire, own } and removes nothing; with both it retires the organizations the person solely owns and answers { removed, retired }, or 500 { error: \"delete_failed\", failed, removed }",
  auth: true,
  role: "admin",
  body: { retireOrgs: "boolean", confirm: "boolean" },
  refusals: {
    not_allowed: "an admin cannot remove themselves, another admin or an agent (422)",
    last_owner: "the person is the only one owning an organization (409)",
  },
};
