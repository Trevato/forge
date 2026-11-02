import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/search", summary: "Search issues, pulls, repositories and code; `kind` narrows it", auth: false, query: { q: "string", kind: "string", limit: "integer" }, refusals: { invalid_kind: "kind is not all, repos, issues or code (422)", invalid_limit: "limit is not a whole number from 1 to 100 (422)" }, reply: { repos: "array", issues: "array", code: "array", truncated: "object", moreCode: "boolean", codeSkipped: "boolean", note: "string, only when q is blank: what to send" } };
