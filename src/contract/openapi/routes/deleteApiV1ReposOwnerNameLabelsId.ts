import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "delete", path: `${REPO}/labels/{id}`, summary: "Remove a label by id (admin scope, repository admin); answers 204 with no body, 404 when the repository has no such label", auth: true, status: 204 };
