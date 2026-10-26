import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/explore", summary: "Explore apps and repositories; `q` takes words and `kind:`/`owner:` filters; answers { query, items }", auth: false, query: { q: "string" } };
