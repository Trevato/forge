import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/pinned/{name}/rollback",
  summary: "One action back to the version the latest change replaced; recorded like any change",
  auth: true,
  role: "admin",
  refusals: {
    not_found: "only a forge administrator sees this route",
    refused: "the request was understood and refused; the message says why (422)",
  },
};
