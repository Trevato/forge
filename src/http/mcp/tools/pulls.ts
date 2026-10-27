import { sealedScope } from "../../../core/sealed.ts";
import { reviewSummariesFor } from "../../../core/reviews.ts";
import { listPulls, pullDir, pullMergeStates } from "../../../core/pulls.ts";
import { checkSummary } from "../../../core/runs.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "pulls",
  doc: "`{ repo, state?, limit? }`: a repository's pulls, newest first, one brief line each: `number`, `title`, `author`, `head`, `check` (state), `approvals`, `changesRequested`, `mergeable` (null once closed); `state` open (default) or closed, `limit` 1-50 (default 20); no bodies, no diffs",
  description:
    "A repository's pulls, newest first. `state` open (default) or closed; `limit` 1-50.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      state: { type: "string", enum: ["open", "closed"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const state = args["state"] ?? "open";
    if (state !== "open" && state !== "closed")
      return bad("invalid", "`state` is open or closed");
    const limit = args["limit"] ?? 20;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
      return bad("invalid", "`limit` is a whole number from 1 to 50");
    const db = ctx.app.db;
    const pulls = listPulls(db, repo.id, { state, limit, ...sealedScope(db, repo, user) });
    const reviews = reviewSummariesFor(db, pulls);
    const dirs = await Promise.all(
      pulls.map((p) => pullDir(db, ctx.app.reposRoot, repo, p)),
    );
    const merge = await pullMergeStates(pulls.map((pull, i) => ({ dir: dirs[i]!, pull })));
    const answer = good({
      pulls: pulls.map((p, i) => ({
        number: p.number,
        title: p.title,
        author: p.authorName,
        head: p.headBranch,
        check: checkSummary(db, p.id, p.headOid).state,
        approvals: reviews.get(p.id)?.approvals ?? 0,
        changesRequested: reviews.get(p.id)?.changesRequested ?? 0,
        mergeable: merge[i]?.mergeable ?? null,
      })),
    });
    // What the card needs and the text does not say: where the pulls live, and
    // the limit that may have cut the list short.
    return { ...answer, card: { repo: `${repo.ownerName}/${repo.name}`, state, limit } };
  },
};
