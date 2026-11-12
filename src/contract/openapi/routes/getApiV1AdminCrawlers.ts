import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/admin/crawlers",
  summary:
    "Read the crawlers' share of the last 15 minutes of answering time (a person admin's token, any scope); answers { window_minutes, requests, crawler_requests, ms, crawler_ms, deep_stranger_requests, deep_stranger_ms, share, refused: [{ agent, refused }], refused_by_budget: { address, agent, shared, stranger } }",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge" },
};
