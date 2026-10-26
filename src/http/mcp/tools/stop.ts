import { cancelRepoRun } from "../../../actions/runs.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "stop",
  doc: "stop one run by its id from `now`",
  description:
    "Stop one of the crew's runs, by its id from `now`. Its pushes stay; nothing is re-queued.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, run: { type: "string" } },
    required: ["repo", "run"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const stopped = cancelRepoRun(ctx.app, user, repo, str(args["run"]));
    return stopped.ok
      ? good({ says: `Stopped run ${stopped.value.id}.` })
      : bad(
          stopped.error,
          stopped.error === "finished"
            ? "that run already ended"
            : "no such run here, or not yours to stop",
        );
  },
};
