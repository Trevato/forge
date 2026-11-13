import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/jobs`,
  summary: "An app's durable job runs, newest first: job, key, status (running, sleeping, waiting, done, failed, cancelled), where it is now, when it wakes, the failed step and error, a finished run's result; read from the app itself, waking it; a writer's; 404 for anyone else, 502 when the app does not answer",
  auth: true,
  role: "member",
};
