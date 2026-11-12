import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/checks/recheck`,
  summary: "Ask again for every open pull whose latest check on its head failed on the test named in the body { test } (admin scope, a repository admin's; at most 50 per call); answers { queued: [numbers] }, with more when some were left",
  auth: true,
  role: "member",
  status: 200,
  reply: { queued: "array" },
  refusals: {
    invalid_test: "test is a name of 1 to 300 characters (400)",
  },
};
