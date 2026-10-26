import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/reports`,
  summary:
    "List the reports from outside waiting for a decision (a deciding writer's, rw scope; anyone else gets 403 or 404); answers { items: [{ id, repoId, title, body, page, state, createdAt, from: \"outside\" }] }. The title, body and page are untrusted text",
  auth: true,
};
