import type { Route } from "../shared.ts";

export const route: Route = {
  method: "patch",
  path: "/api/v1/agents/{username}",
  summary: "Change an agent's model, brief or budget (an admin token, or a person's session); answers the agent",
  auth: true,
  role: "member",
  body: { model: "string", brief: "string", budgetUsd: "integer" },
  refusals: { forbidden: "a token below admin scope" },
};
