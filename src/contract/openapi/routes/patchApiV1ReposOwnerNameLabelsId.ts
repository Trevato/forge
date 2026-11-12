import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "patch", path: `${REPO}/labels/{id}`, summary: "Rename or recolour a label by id (admin scope, repository admin); body { name?, color? } with at least one; answers the label { id, name, color } and keeps its id; 404 when the repository has no such label, 422 for a taken name or a colour that is not six hex digits", auth: true, role: "member", body: { name: "string", color: "string" }, refusals: { forbidden: "a token below admin scope" } };
