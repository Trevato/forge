import { envRefusalText } from "../../../actions/env_words.ts";
import { pullNow, PULL_NOW_REFUSALS } from "../../../actions/app_pull.ts";
import { redeployEnv, stopEnv } from "../../../actions/apps.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "app_deploy",
  doc: "`{ repo, env, action }`: `redeploy` or `stop` an app's `production` or a pull's `pull-N` preview; a writer's, queued as `POST …/app/:env/redeploy` and `…/stop` are; answers `{ queued, run }` or `{ stopped }`. `{ repo, action: \"pull\" }` runs an adapter's pull now as `POST …/app/pull` does; answers `{ run }`",
  description:
    "Redeploy or stop production or a pull-N preview, or pull an adapter now.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      env: { type: "string" },
      action: { type: "string", enum: ["redeploy", "stop", "pull"] },
    },
    required: ["repo", "action"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const env = str(args["env"]);
    const action = str(args["action"]);
    if (action === "pull") {
      const pulled = await pullNow(ctx.app, user, repo);
      return pulled.ok ? good({ run: pulled.value }) : bad(pulled.error, PULL_NOW_REFUSALS[pulled.error]);
    }
    if (action !== "redeploy" && action !== "stop")
      return bad("invalid_action", "action is redeploy, stop or pull");
    if (action === "stop") {
      const stopped = await stopEnv(ctx.app, user, repo, env);
      return stopped.ok
        ? good({ stopped: true })
        : bad(stopped.error, envRefusalText(stopped.error));
    }
    const queued = await redeployEnv(ctx.app, user, repo, env);
    return queued.ok
      ? good({ queued: true, run: queued.value?.id ?? null })
      : bad(queued.error, envRefusalText(queued.error));
  },
};
