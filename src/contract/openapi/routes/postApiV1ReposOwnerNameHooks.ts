import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/hooks`,
  summary: "Add a webhook (admin scope); answers 201 with the webhook and its `secret`, shown once",
  auth: true,
  role: "member",
  status: 201,
  body: { url: "string", kinds: "string", secret: "string" },
  refusals: { invalid: "`url` or `kinds` is not acceptable (422)" },
};
