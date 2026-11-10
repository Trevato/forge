import { FOLLOW_MODE_REFUSALS, followModeSaid, setFollowMode } from "../../../actions/follow.ts";
import { forkParentFor } from "../../../core/repos.ts";
import { FORK_FOLLOW_MODES } from "../../../core/fork_follow.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "follow_mode",
  doc: "`{ repo, mode }`: choose how a fork follows its parent: `take-updates`, `tell-me` or `dont-follow` (a spawned forge: the first two; it severs instead); the admin only; answers `{ says, mode }`; refused `unauthorized`, `forbidden`, `not_following`, `invalid_mode` or `severed`",
  description:
    "How a fork follows its parent: take updates, tell me, or don't follow.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      mode: { type: "string", enum: [...FORK_FOLLOW_MODES] },
    },
    required: ["repo", "mode"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const set = await setFollowMode(ctx.app, user, repo, args["mode"]);
    if (set.ok) return good({ says: followModeSaid(forkParentFor(ctx.app.db, repo, user), set.value), mode: set.value });
    return bad(set.error, FOLLOW_MODE_REFUSALS[set.error].message);
  },
};
