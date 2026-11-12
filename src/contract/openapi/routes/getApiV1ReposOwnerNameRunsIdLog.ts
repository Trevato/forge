import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/runs/{id}/log`, summary: "Read a run's log as text/plain, one line per line; follow=1 or Accept: text/event-stream tails it live as server-sent events (line, then done); 404 when the log is hidden", auth: false, role: "anonymous", query: { follow: "string" } };
