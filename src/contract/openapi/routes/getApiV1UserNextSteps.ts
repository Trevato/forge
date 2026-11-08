import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/user/next-steps",
  summary: "On a spawned forge, its owner's first three steps (everyday, apps, tell), each with whether it is done; needs a token with scope ro or better; answers { steps } with [] elsewhere, for an agent, or for anyone but the owner; the same JSON as MCP next_steps",
  auth: true,
};
