import { upstreamPayload } from "../../../spawn/upstream.ts";
import { relationOf } from "../../../actions/forks.ts";
import { chainOfRepo } from "../../../spawn/chain.ts";
import { convergeState } from "../../../crew/converge.ts";
import { parentForgeFor } from "../../../core/parent_releases.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "following",
  doc: "where a fork stands against what it follows, and what the crew is doing about it",
  description:
    "Where a fork stands against what it follows: in step, behind, ahead, diverged.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const relation = await relationOf(ctx.app, user, repo);
    const chain = await chainOfRepo(ctx.app, repo);
    if (relation === undefined)
      return chain === undefined
        ? bad("not_a_fork", "this repository follows nothing")
        : good({ chain: chain.lines, severedAt: chain.severedAt, upstream: await upstreamPayload(ctx.app) });
    const converge =
      relation.state === "diverged" && !relation.clean
        ? convergeState(ctx.app, repo, relation.parent)
        : undefined;
    return good({
      chain: chain?.lines ?? null,
      severedAt: chain?.severedAt ?? null,
      upstream: chain === undefined ? null : await upstreamPayload(ctx.app),
      parent: `${relation.parent.ownerName}/${relation.parent.name}`,
      state: relation.state,
      behind: relation.behind,
      ahead: relation.ahead,
      clean: relation.clean,
      conflicts: relation.conflicts,
      parentForge: parentForgeFor(ctx.app.config),
      converge: converge?.kind ?? null,
    });
  },
};
