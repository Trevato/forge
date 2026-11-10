import { FOLLOW_MODE_REFUSALS, followModeSaid, setFollowMode } from "../../../actions/follow.ts";
import { forkParentFor } from "../../../core/repos.ts";
import { FOLLOW_MODES } from "../../../spawn/chain.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "follow_mode",
  doc: "`{ repo, mode }`: choose how a spawned forge follows its parent, `mode` being `tell-me` or `take-updates`; its `forge` repository's admin only; answers `{ says, mode }`; refused `unauthorized`, `forbidden`, `not_following`, `invalid_mode` or `severed`",
  description:
    "How a spawned forge follows its parent: `tell-me` or `take-updates`.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      mode: { type: "string", enum: [...FOLLOW_MODES] },
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
