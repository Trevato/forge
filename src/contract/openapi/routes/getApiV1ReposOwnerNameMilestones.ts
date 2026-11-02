import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/milestones`, summary: "Read the plan: { items, next_cursor }, one limb per milestone with its weights (and askToLive for a pillar's umbrella); limit 1–200 (default 50), cursor is the next_cursor of the page before; a private repository needs a token", auth: false, query: { limit: "integer", cursor: "string" } };
