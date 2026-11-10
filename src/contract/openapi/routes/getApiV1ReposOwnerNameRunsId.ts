import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/runs/{id}`, summary: "Read one run as this reader may see it, with `carries`, the merged pulls a finished production deploy carries", auth: false, role: "anonymous" };
