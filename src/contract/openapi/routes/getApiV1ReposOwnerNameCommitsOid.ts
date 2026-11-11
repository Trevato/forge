import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/commits/{oid}`, summary: "Read one commit (a full or abbreviated id, or a ref) as { oid, parents, author, email, date, subject, body, diff: { files, additions, deletions } }; a private repository needs a token", auth: false, role: "anonymous" };
