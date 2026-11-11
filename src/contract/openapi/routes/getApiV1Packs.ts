import type { Route } from "../shared.ts";

export const route: Route = { method: "get", path: "/api/v1/packs", summary: "The curated packs: { items: [{ name, title, pitch, brief, repos, shown }] }; shown is the public repos on this forge; repos (the list as kept) and left_out come only to a person admin", auth: false, role: "anonymous" };
