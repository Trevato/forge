import { listRepoRuns } from "../../../actions/runs.ts";
import { getIssueById } from "../../../core/issues.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "runs",
  doc: "`{ repo, limit? }`: the repository's recent runs, newest first (id, kind, state, issue or pull number, started, ended), 1–50, default 20; read as the runs page reads them",
  description:
    "A repository's runs, newest first: id, kind, state, issue or pull, started and ended.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "1–50, default 20.",
      },
    },
    required: ["repo"],
  },
  writes: false,
  run(ctx, user, args) {
    const limit = args["limit"] ?? 20;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return bad("bad_limit", "limit is a whole number from 1 to 50");
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const runs = listRepoRuns(ctx.app, user, repo, { limit });
    if (!runs.ok) return bad("not_found", "no such app or repository (owner/name)");
    return good({
      runs: runs.value.map((r) => ({
        id: r.id,
        kind: r.kind,
        state: r.state,
        number:
          r.issueId === null ? null : (getIssueById(ctx.app.db, r.issueId)?.number ?? null),
        startedAt: r.startedAt,
        endedAt: r.finishedAt,
      })),
    });
  },
};
