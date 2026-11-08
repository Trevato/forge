import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/admin/pinned/{name}/update",
  summary: "The only way a pinned forge changes version or config; recorded with who and when",
  auth: true,
  body: { version: "string", config: "object" },
  refusals: {
    not_found: "only a forge administrator sees this route",
    refused: "the request was understood and refused; the message says why (422)",
  },
};
