import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/packs/{name}", summary: "One curated pack: { name, title, pitch, brief, shown } (shown: the public repos on this forge), and for a person admin also repos, left_out and the history of who changed what and when", auth: false, role: "anonymous", refusals: { not_found: "404: no such pack" } };
