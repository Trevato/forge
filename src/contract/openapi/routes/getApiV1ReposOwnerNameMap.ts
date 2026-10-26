import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/map`, summary: "Read the plan: issues, their dependency edges and pillars", auth: false };
