import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/hooks`, summary: "List the repository's webhooks (admin scope); answers an array of webhooks", auth: true };
