import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/forge/view",
  summary: "The forge as one read-only picture for a reader that draws it: { counts: { apps, running, queued, waiting }, apps: [{ app, slug, access, running, queued }], runs: [the rows of /api/v1/crew/now; each run's state is its station], health: as /api/v1/health answers this caller, at } for the apps the caller may read. Any token scope reads it; it is built at most once per two seconds per caller and answers 304 to a held ETag, so polling it is cheap",
  auth: true,
  refusals: { unauthorized: "no valid credentials were sent" },
};
