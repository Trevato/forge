import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/schedules/{schedule}/{action}`,
  summary: "Steer a schedule: run (once now, apart from its clock), pause or resume (rw scope, writer); ?env= names a preview, production by default; 404 no such schedule, 422 another action",
  auth: true,
  role: "member",
};
