import { REPO, type Route } from "../shared.ts";
import { ENABLED_WORDS } from "../../../core/arg_words.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/upstream`,
  summary: "Follow an outside upstream, or stop (admin scope, repository admin); answers { following }",
  auth: true,
  body: { url: "string", branch: "string", enabled: "boolean" },
  refusals: {
    bad_enabled: `422: ${ENABLED_WORDS}`,
    invalid_url: "422: not an https or http git address",
    invalid_branch: "422: not a branch name git accepts",
    not_found: "404: no such repository, or it is not readable by the caller",
  },
};
