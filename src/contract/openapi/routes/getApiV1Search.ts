import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/search", summary: "Search issues, pulls, repositories and code; `kind` narrows it", auth: false, query: { q: "string", kind: "string" }, reply: { repos: "array", issues: "array", code: "array", truncated: "object", moreCode: "boolean", codeSkipped: "boolean", note: "string, only when q is blank or kind is unknown: what to send" } };
