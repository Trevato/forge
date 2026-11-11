import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/commits/{oid}/check`, summary: "The default branch's check of a full 40-hex commit id, never cached: { commit, checkedCommit, state, runId, summary, finishedAt }; state is ok, failed, pending, superseded or none; 404 for a short id, an unknown commit or a repository you cannot read", auth: false, role: "anonymous" };
