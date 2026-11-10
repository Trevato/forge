import { upstreamPayload } from "../../../spawn/upstream.ts";
import { relationOf } from "../../../actions/forks.ts";
import { followModeOf } from "../../../actions/follow.ts";
import { chainOfRepo } from "../../../spawn/chain.ts";
import { convergeState } from "../../../crew/converge.ts";
import { parentForgeFor } from "../../../core/parent_releases.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "following",
  doc:
    "`{ repo }`: for a fork `{ parent, mode, state, behind, ahead, clean, conflicts, action, words, parentForge, converge, chain, severedAt, upstream }`, where it stands against what it follows (`mode` take-updates, tell-me or dont-follow, set by `follow_mode`; `state` in step, behind, ahead or diverged; `behind`/`ahead` commits; `clean` whether a merge would apply; `conflicts` the files that clash; `action` the one thing that reconciles it (none, fast-forward, offer, merge, keep-both) and `words` it said plainly; `converge` what the crew is doing about a conflict, else `null`; `parentForge`, `chain`, `severedAt` and `upstream` the forge-to-forge link, `null` when there is none); for a repository that is no fork but a spawned forge, only `{ chain, severedAt, upstream }`; refused `not_a_fork` when it follows nothing, `not_found` for a repository the caller may not see",
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
      mode: await followModeOf(ctx.app, repo),
      state: relation.state,
      behind: relation.behind,
      ahead: relation.ahead,
      clean: relation.clean,
      conflicts: relation.conflicts,
      action: relation.action,
      words: relation.words,
      parentForge: parentForgeFor(ctx.app.config),
      converge: converge?.kind ?? null,
    });
  },
};
