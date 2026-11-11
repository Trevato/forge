import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/prompts`,
  summary: "Add a prompt source (admin scope); answers 201 with the source",
  auth: true,
  role: "member",
  status: 201,
  body: { kind: "string", token: "string", at: "string" },
  refusals: { invalid: "`kind`, `token` or `at` is not acceptable (422)" },
};
