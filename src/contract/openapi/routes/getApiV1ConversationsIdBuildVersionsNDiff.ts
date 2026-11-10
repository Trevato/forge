import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/conversations/{id}/build/versions/{n}/diff",
  summary: "The files and lines one version changed against the version before it; an unknown n is 404",
  auth: true,
  role: "member",
  reply: { files: "array" },
  refusals: {
    not_found: "no such build of yours (404)",
    unauthorized: "sign in (401)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
