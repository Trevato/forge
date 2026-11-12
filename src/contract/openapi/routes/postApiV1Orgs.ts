import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/orgs",
  summary: "Make an organisation (rw scope); answers 201 with { id, username, kind: \"org\" }",
  auth: true,
  role: "member",
  status: 201,
  body: { name: "string" },
};
