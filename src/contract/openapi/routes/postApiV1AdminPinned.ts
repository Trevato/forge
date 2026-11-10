import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/pinned",
  summary: "Put a pinned forge on the owner's cloud: no crew, no automatic release; needs an admin-scope token and a cloud account with writes allowed",
  auth: true,
  role: "admin",
  status: 201,
  body: { name: "string", target: "string", account: "string", app: "string", source: "string", version: "string", config: "object" },
  refusals: {
    not_found: "only a forge administrator sees this route",
    refused: "the request was understood and refused; the message says why (422)",
  },
};
