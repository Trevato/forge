import type { Route } from "../shared.ts";

export const route: Route = { method: "delete", path: "/api/v1/agents/{username}", summary: "Remove an agent (an admin token, or a person's session); answers {}", auth: true, role: "member", refusals: { forbidden: "a token below admin scope", not_found: "no such agent" } };
