import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/conversations/{id}/build/restore",
  summary: "Restore a version: make a new version holding exactly what version n held; history is kept",
  auth: true,
  role: "member",
  status: 201,
  body: { version: "number" },
  reply: { version: "object" },
  refusals: {
    not_found: "no such build of yours (404)",
    unauthorized: "sign in (401)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
