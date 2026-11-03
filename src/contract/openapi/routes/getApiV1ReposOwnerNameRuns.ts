import { REPO, type Route, limitTo } from "../shared.ts";
import { LIST_LIMIT_MAX } from "../../../core/issues.ts";

export const route: Route = { method: "get", path: `${REPO}/runs`, summary: "List a repository's runs, newest first: { items, next_cursor }; kind deploy or agent, state queued, running, ok, failed or cancelled (another is a 422), env an environment name, limit 1 to 200 (default 50), cursor a run id; each row carries `shown`, the state worked out from what the run did; a stranger's runs carry no cost, turns, agent session or node", auth: false, query: { kind: "string", state: "string", env: "string", limit: limitTo(LIST_LIMIT_MAX), cursor: "string" } };
