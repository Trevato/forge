import type { Route } from "../shared.ts";

export const route: Route = {
  method: "delete",
  path: "/api/v1/features/{slug}",
  summary: "Un-absorb an app (a site admin's admin scope token): it runs as an ordinary app again; its settings are kept for the next absorb; answers the feature",
  auth: true,
  refusals: {
    not_found: "no such app, or one you may not read",
    forbidden: "you are not a site admin (403)",
    not_absorbed: "the app is not absorbed (409)",
  },
};
