import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/flow`,
  summary: "Read how work moves through a repository: { open, live }, where open lists each open issue (and merged ones production has not yet served) as { number, title, stage, since, stalled, unblock, pull } and live lists what went live in the last 24 hours, newest first, the same with liveAt; sealed rows only for those who may see them",
  auth: false,
  role: "anonymous",
  refusals: { not_found: "no such repository, or it is not readable by the caller" },
};
