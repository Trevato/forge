import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/agents", summary: "List the crew's agents; answers { items, next_cursor: null }; needs a signed-in caller, anonymous gets 401", auth: true, role: "member" };
