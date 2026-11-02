import { driftOfForks } from "../../../actions/forks.ts";
import { forkParentFor, visibleForks } from "../../../core/repos.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "forks",
  doc: "`{ repo }`: `{ parent, forks: [{ repo, ahead, behind, updatedAt }] }`, the forks the caller may see (as `/:owner/:name/forks` lists them), each with its commits ahead of and behind this one; `null` when git cannot say",
  description: "A repo's forks you may see, each with commits ahead and behind.",
  inputSchema: { type: "object", properties: { repo: REPO_ARG }, required: ["repo"] },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const parent = forkParentFor(ctx.app.db, repo, user);
    const ranked = await driftOfForks(ctx.app, repo, visibleForks(ctx.app.db, repo.id, user));
    const rows = ranked.map(({ fork, drift, pushedAt }) => ({
      repo: `${fork.ownerName}/${fork.name}`,
      ahead: drift.ahead,
      behind: drift.behind,
      updatedAt: pushedAt,
    }));
    return good({
      parent: parent === undefined ? null : `${parent.ownerName}/${parent.name}`,
      forks: rows,
    });
  },
};
