import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/conversations/{id}/build/publish",
  summary: "Publish: merge the build's branch to the default branch, which deploys production; answers its address. 409 when no version has changed the app",
  auth: true,
  role: "member",
  reply: { published: "boolean" },
  refusals: {
    not_found: "no such build of yours (404)",
    unauthorized: "sign in (401)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
