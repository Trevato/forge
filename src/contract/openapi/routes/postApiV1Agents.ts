import type { Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: "/api/v1/agents",
  summary: "Make an agent on the crew (an admin token, or a person's session); answers 201 with the agent",
  auth: true,
  role: "member",
  status: 201,
  body: { username: "string", displayName: "string", model: "string", brief: "string", budgetUsd: "integer" },
  refusals: { forbidden: "a token below admin scope", unauthorized: "no account" },
};
