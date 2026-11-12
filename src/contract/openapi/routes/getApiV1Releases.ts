import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/releases",
  summary: "The kept releases newest first, for the forge's administrators and its repository's readers; ?shipped=true is what went live and what is on its way, for anyone; the 200 carries a weak etag of the JSON sent (shipped: cache-control public, max-age=60; kept releases: private, no-cache with vary authorization, cookie), a repeat sending If-None-Match gets 304 with no body, and a 403 or 422 carries no etag",
  alsoStatus: [304],
  auth: false,
  role: "anonymous",
  query: { shipped: "boolean" },
  refusals: {
    forbidden: "the release history is for the forge's administrators and its repository's readers",
    invalid_shipped: "shipped is true or absent (422)",
  },
};
