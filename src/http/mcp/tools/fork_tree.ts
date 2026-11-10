import { forkTree } from "../../../actions/fork_tree.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

/** The whole tree a repo sits in, as the caller may read it. */
export const tool: Tool = {
  name: "fork_tree",
  doc: "`{ repo, depth?, limit? }`: `{ root, nodes: [{ repo, parent, depth, follow }], truncated }`, the fork tree around a repo from its topmost readable ancestor down: ancestors, siblings and descendants the caller may read, nothing else; `follow` is `autonomous` (the root), `take-updates` or `offers`; `depth` 1-8 (default 4), `limit` 1-200 nodes (default 200); `truncated` is true when more exists than is shown",
  description: "The fork tree around a repo: ancestors, siblings and descendants you may read.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      depth: { type: "integer", minimum: 1, maximum: 8 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const opts: { depth?: number; limit?: number } = {};
    if (typeof args["depth"] === "number") opts.depth = args["depth"];
    if (typeof args["limit"] === "number") opts.limit = args["limit"];
    const tree = forkTree(ctx.app.db, repo, user, opts);
    return good(tree ?? { root: null, nodes: [], truncated: false });
  },
};
