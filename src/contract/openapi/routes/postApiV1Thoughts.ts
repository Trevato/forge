import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/thoughts",
  summary: "Keep a thought (rw scope); answers 201 with { id }",
  auth: true,
  role: "member",
  status: 201,
  body: { text: "string" },
  refusals: { invalid: "text is not a string within the length limit" },
};
