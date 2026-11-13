import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/jobs/{id}/{action}`,
  summary: "Steer a job run: cancel an unfinished one, or retry a failed one from its failed step (rw scope, writer); 422 when the run is not in a state that allows it or another action, 502 when the app does not answer",
  auth: true,
  role: "member",
};
