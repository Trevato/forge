import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/app-templates",
  summary:
    "Mark or unmark a repository as an app template (site admin, admin scope); send { repo: \"owner/name\", marked: true|false }; the default template cannot be unmarked",
  auth: true,
  role: "admin",
  refusals: {
    forbidden: "the caller is not a site admin",
    invalid_body: "repo and marked are required",
    default_template: "the default template is always offered",
  },
};
