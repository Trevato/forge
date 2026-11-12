import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/conversation/queue/{id}",
  summary: "Take back a message queued for after the running turn; one that already went stays sent",
  auth: true,
  role: "member",
  reply: { ok: "boolean" },
  refusals: {
    not_found: "no such waiting message of yours (404)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
