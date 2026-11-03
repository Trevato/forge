import { stopTalk } from "../../../actions/talk.ts";
import { cancelRepoRun } from "../../../actions/runs.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "stop",
  doc: "`{ repo?, run? }`: stop one run by its id from `now`; with no `repo` it stops the forge's own agent mid-answer",
  description:
    "Stop a crew run by its id from `now`; with no repo, the forge's own agent mid-answer.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, run: { type: "string" } },
    required: [],
  },
  writes: true,
  run(ctx, user, args) {
    if (args["repo"] === undefined && args["run"] === undefined) {
      if (ctx.auth.through !== undefined) return bad("forbidden", "the forge's agent cannot stop itself");
      const talked = stopTalk(ctx.app, user);
      return talked.ok ? good({ says: "Stopped the forge's agent; what it said stays." }) : bad(talked.error, talked.error === "idle" ? "no answer is running" : "the forge's agent is not running here");
    }
    if (args["repo"] === undefined || args["run"] === undefined)
      return bad("invalid", "to stop a crew run give both `repo` and `run`; give neither to stop the forge's agent");
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
