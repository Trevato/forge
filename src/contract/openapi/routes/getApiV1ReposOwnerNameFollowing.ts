import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/following`,
  summary:
    "A fork's standing against its parent, read from git: { chain, severedAt, upstream, parent, parentBranch, parentFrozen, branch, state, behind, ahead, clean, conflicts, forkTip, parentTip, parentForge, converge }; a repository that only follows across forges answers { chain, severedAt, upstream }",
  auth: false,
  role: "anonymous",
  refusals: { not_a_fork: "404: this repository follows nothing" },
};
