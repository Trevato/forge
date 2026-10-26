import { runLog } from "../../../actions/runs.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "run_log",
  doc: "`{ repo, run, tail? }`: a run's log, or its last `tail` lines (1–2000), with the REST route's access: a hidden log or unreadable repository is not found",
  description:
    "A run's log, or its last `tail` lines, as GET /api/v1/repos/:owner/:name/runs/:id/log.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { ...REPO_ARG, maxLength: 140 },
      run: { type: "string", maxLength: 80 },
      tail: {
        type: "integer",
        minimum: 1,
        maximum: 2000,
      },
    },
    required: ["repo", "run"],
  },
  writes: false,
  run(ctx, user, args) {
    const tail = args["tail"];
    if (
      typeof args["run"] !== "string" ||
      args["run"].length === 0 ||
      args["run"].length > 80 ||
      (tail !== undefined &&
        (typeof tail !== "number" ||
          !Number.isInteger(tail) ||
          tail < 1 ||
          tail > 2000))
    )
      return bad("invalid", "`run` is a run id; `tail` is 1 to 2000 lines");
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const found = runLog(ctx.app, user, repo, args["run"]);
    // A hidden log is not found, as on the REST route.
    if (!found.ok || found.value.logHidden)
      return bad("not_found", "no such run here");
    const all = found.value.lines;
    const lines = tail === undefined ? all : all.slice(-tail);
    return good({
      run: found.value.run.id,
      lines,
      truncated: found.value.truncated || lines.length < all.length,
    });
  },
};
