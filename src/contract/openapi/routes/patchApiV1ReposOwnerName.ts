import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: REPO,
  summary:
    "Change a repository's settings (an admin's); `showProvenance` shows or hides where a migrated one came from (a person's, never an agent's)",
  auth: true,
  role: "member",
  body: {
    description: "string",
    visibility: "string",
    archived: "boolean",
    showProvenance: "boolean",
    defaultBranch: "string",
    protectDefault: "boolean",
    requireReview: "boolean",
    requireChecks: "boolean",
    crewOutsiders: "boolean",
    decisionsBy: "string",
    plansNeedNod: "boolean",
  },
  refusals: {
    bad_archived: "422: archived is true or false",
    bad_decisions_by: "422: decisionsBy is me, decider or decider_tell",
    bad_plans_need_nod: "422: plansNeedNod is true or false",
    bad_show_provenance: "422: showProvenance is true or false",
    no_provenance: `422: ${FAMILY_WORDS.no_provenance}`,
    forbidden: "403: only an admin archives or wakes",
    not_found: "404: no such repository, or it is not readable by the caller",
  },
};
