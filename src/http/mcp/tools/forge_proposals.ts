import { forgeProposalLine, forgeProposals } from "../../../actions/upstream.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "forge_proposals",
  doc: "`{ repo }`: what this forge proposed to its parent, newest first; `reachable` is false if the parent did not answer",
  description:
    "What this forge proposed to its parent; `reachable` false if it is silent.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const items = await forgeProposals(ctx.app, repo, Date.now(), true);
    return good({ items: items.map((p) => ({ ...p, says: forgeProposalLine(p) })) });
  },
};
