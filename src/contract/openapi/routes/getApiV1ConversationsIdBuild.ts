import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/conversations/{id}/build",
  summary: "The app a conversation builds: its repository, branch, versions (the branch's commits past the default branch, numbered from v1), the preview address once there is a version, and whether it is published",
  auth: true,
  role: "member",
  reply: { repo: "string", versions: "array", published: "boolean" },
  refusals: {
    not_found: "no such build of yours (404)",
    unauthorized: "sign in (401)",
    forbidden: "the request is cross-origin, or the token may only read",
  },
};
