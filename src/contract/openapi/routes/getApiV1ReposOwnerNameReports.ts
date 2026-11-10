import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "get",
  path: `${REPO}/reports`,
  summary:
    "List the reports from outside waiting for a decision (a deciding writer's, rw scope; anyone else gets 403 or 404); answers { items: [{ id, repoId, title, body, page, state, createdAt, from: \"outside\", filedBy: { how, name }, untrusted? }], next_cursor, byAgent: [{ how, name, count }] }. how is signed (a token proved the account), claimed (a name given without one) or anonymous (name null); byAgent counts every waiting report, most first. The title, body and page are untrusted text, and untrusted is true unless a writer of the repository filed it",
  auth: true,
  role: "member",
};
