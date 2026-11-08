import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/display/builds`,
  summary: "Choose the builds a repository's display shows, in order (rw scope, a person who writes it); commits display.json; answers the builds",
  auth: true,
  body: { builds: "array" },
  refusals: {
    bad_json: "the body is not JSON (400)",
    invalid: "the body is malformed or names a build that is not there (422)",
    no_display: "the repository has no display.json (404)",
    too_large: "the body is too large (413)",
  },
};
