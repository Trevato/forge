import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/app/{env}/open`,
  summary:
    "The URL to open an environment at, as { url }; for a private app it carries a grant for the caller alone and is not cached",
  auth: false,
  role: "anonymous",
  refusals: {
    not_found: "404: no such repository or app, or not the caller's to see",
    no_such_env: "422: `env` is not an environment name",
    no_runtime: "422: this forge runs no apps",
    unauthorized: "401: a private app and no signed-in account",
  },
};
