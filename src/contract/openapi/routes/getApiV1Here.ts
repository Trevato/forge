import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/here", summary: "The manifest of what you can do at `path` (default /), given who you are: { here, you, can, mcp, docs }; never cached", auth: false, role: "anonymous", query: { path: "string" }, refusals: { not_found: "404: the path names no page you can read" } };
