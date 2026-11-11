import type { Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: "/api/v1/codes",
  summary: "The forge's gift codes (a person admin's token): each one's plan, note, uses and who redeemed it, newest first. Never the plain code. Answers { codes, plans }",
  auth: true,
  role: "admin",
  refusals: { not_found: "the token is not a person who administers the forge (404)" },
};
