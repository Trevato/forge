import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/app/production/open`, summary: "Open the running app", auth: false, role: "anonymous" };
