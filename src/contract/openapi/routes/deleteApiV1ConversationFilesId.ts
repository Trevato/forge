import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/conversation/files/{id}",
  summary: "Take back an attachment chosen and not yet sent; a sent one stays with its message",
  auth: true,
  reply: { ok: "boolean" },
  refusals: {
    not_found: "no such unsent attachment of yours (404)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
