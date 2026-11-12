import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/orgs/{org}", summary: "Read one organization's public profile plus `teams`, the teams the caller may see: all for an org admin, only their own for a member, [] for a stranger or anonymous caller", auth: false, role: "anonymous" };
