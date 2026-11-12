import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/following/converge`,
  summary: "Ask the crew to converge a diverged fork with its parent; answers { kind, issue, pull, agent } (202 when queued, 200 when working or proposed)",
  auth: true,
  role: "member",
  refusals: {
    not_a_fork: "404: this repository follows nothing",
    forbidden: "403: only someone who may direct the crew",
    archived: "409: the repository is archived",
    ceiling: "429: the crew is at its ceiling",
  },
};
