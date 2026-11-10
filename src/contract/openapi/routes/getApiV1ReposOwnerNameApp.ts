import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/app`, summary: "Read the repository's app: its settings, environments and state", auth: false, role: "anonymous" };
