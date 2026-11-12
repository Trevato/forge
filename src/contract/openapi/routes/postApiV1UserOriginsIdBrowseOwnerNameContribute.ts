import { PROVE_FIRST } from "../../../actions/verify_words.ts";
import { BROWSE, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${BROWSE}/contribute`,
  summary:
    "Contribute to a repository you only browse (admin scope): fork it if you cannot push, branch, commit files and optionally open a pull upstream; answers 201 with the contribution",
  auth: true,
  role: "member",
  status: 201,
  body: { branch: "string", base: "string", message: "string", files: "array", openPull: "object" },
  refusals: {
    not_found: "404: no such origin of yours, or no such repository there",
    unverified: `403: ${PROVE_FIRST}`,
    origin_unreachable: "422: the origin could not be reached",
    invalid_branch: "422: that branch is not one this forge can use",
    unknown_base: "422: that base branch is not one this forge can use",
    fork_timeout: "504: the origin took the fork and it has not appeared yet; try again shortly",
    mirror_failed: "502: a local copy of the repository could not be made",
    pull_failed: "422: the commit landed but the pull did not open; { reason, commit }",
  },
};
