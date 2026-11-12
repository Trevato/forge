import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/issues/{number}/private`,
  summary: "Make, or find, the private repository where a sealed report is fixed by hand; answers 201 { repo, clone }: `owner/name` and its clone URL",
  auth: true,
  role: "member",
  status: 201,
  refusals: {
    not_found: "no such issue, or sealed reports are not the caller's to see",
    not_sealed: "the issue is not sealed, so it has nothing to hide",
    unverified: "the account has not verified its email",
    name_taken: "the owner already has a repository of the private name",
    limit: "the owner is at the daily fork limit",
    fork_failed: "the private repository could not be made",
  },
};
