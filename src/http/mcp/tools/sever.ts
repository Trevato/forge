import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import { severForge } from "../../../actions/follow.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "sever",
  doc: "`{ repo }`: cut a spawned forge's link to the forge its code came from; its `forge` repository's owner only; deletes nothing",
  description:
    "Unlink a spawned forge from its parent (owner of its `forge` repo only). Deletes nothing.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const cut = await severForge(ctx.app, user, repo);
    if (cut.ok) return good({ says: `Severed: following nothing since ${cut.value.slice(0, 10)}.`, severedAt: cut.value });
    return bad(
      cut.error,
      cut.error === "not_following" ? FAMILY_WORDS.not_following : "only this forge's owner can sever it",
    );
  },
};
