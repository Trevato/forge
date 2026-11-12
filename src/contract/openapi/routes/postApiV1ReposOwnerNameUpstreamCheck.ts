import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/upstream/check`,
  summary: "Check the followed upstream now (admin scope); answers the check's result",
  auth: true,
  role: "member",
  refusals: { busy: "409: a check is already running", invalid_url: "422: not an https or http git address" },
};
