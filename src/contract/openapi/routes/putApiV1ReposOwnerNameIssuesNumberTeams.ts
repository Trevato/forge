import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "put",
  path: `${REPO}/issues/{number}/teams`,
  summary: "Replace the crew teams named on an issue (at most two); the pull that closes it is reviewed by each; answers { teams }, the slugs now named. A body without a list of slug strings is a 400",
  auth: true,
  role: "member",
  body: { teams: "array" },
  refusals: {
    too_many: "more teams than an issue may name",
    no_such_team: "a slug names no team",
    mirrored: "the repository mirrors an origin; do it there",
    forbidden: "the caller cannot write to the repository",
  },
};
