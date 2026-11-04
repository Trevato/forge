import { driftOfForks, MAX_RANKED_FORKS, type RankedFork } from "../../../actions/forks.ts";
import { forkParentFor, visibleForks, type Repo } from "../../../core/repos.ts";
import { pageRows } from "../page.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "forks",
  doc: "`{ repo, limit?, cursor? }`: `{ parent, forks: [{ repo, ahead, behind, updatedAt }], next_cursor }`, the forks the caller may see in the order `/:owner/:name/forks` lists them, each with its commits ahead of and behind this one (`null` when git cannot say); `limit` 1-200 (default 50), `cursor` the last `next_cursor` (null on the last page); drift is read for the page only",
  description: "A repo's forks you may see, paged by limit and cursor (next_cursor), each with commits ahead and behind.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      limit: { type: "integer", minimum: 1, maximum: 200 },
      cursor: { type: "string" },
    },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const parent = forkParentFor(ctx.app.db, repo, user);
    const paged = pageRows(visibleForks(ctx.app.db, repo.id, user), (f) => f.id, args);
    if (!paged.ok) return paged;
    const { items, next_cursor } = paged.value as { items: Repo[]; next_cursor: string | null };
    // Drift is read for this page only, in runs of what one call ranks.
    const ranked: RankedFork[] = [];
    for (let i = 0; i < items.length; i += MAX_RANKED_FORKS)
      ranked.push(...(await driftOfForks(ctx.app, repo, items.slice(i, i + MAX_RANKED_FORKS))));
    const rows = ranked.map(({ fork, drift, pushedAt }) => ({
      repo: `${fork.ownerName}/${fork.name}`,
      ahead: drift.ahead,
      behind: drift.behind,
      updatedAt: pushedAt,
    }));
    return good({
      parent: parent === undefined ? null : `${parent.ownerName}/${parent.name}`,
      forks: rows,
      next_cursor,
    });
  },
};
