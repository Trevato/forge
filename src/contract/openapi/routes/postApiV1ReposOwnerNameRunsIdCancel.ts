import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/runs/{id}/cancel`,
  summary: "Cancel a run that has not finished (needs rw scope and write access); answers the cancelled run",
  auth: true,
  role: "member",
  refusals: { finished: "the run has already finished (409)" },
};
