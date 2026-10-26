import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/runs`, summary: "List a repository's runs, newest first: { items, next_cursor }; kind deploy or agent, env an environment name, limit 1 to 200 (default 50), cursor a run id; a stranger's runs carry no cost, turns, agent session or node", auth: false, query: { kind: "string", env: "string", limit: "integer", cursor: "string" } };
