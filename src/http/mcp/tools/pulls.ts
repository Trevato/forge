import { canRead, getReposByIds } from "../../../core/repos.ts";
import { mayView, sealedScope } from "../../../core/sealed.ts";
import { reviewSummariesFor } from "../../../core/reviews.ts";
import { listPulls, openPullPileRows, pullDir, pullMergeStates, pullsByIssueIds } from "../../../core/pulls.ts";
import { checkSummary } from "../../../core/runs.ts";
import type { Ctx } from "../../context.ts";
import type { User } from "../../../core/users.ts";
import { whyPulls } from "../../../flow/why.ts";
import { pageRows } from "../page.ts";
import { good, bad, type Args, type Answer, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "pulls",
  doc: "`{ repo?, state?, limit?, cursor? }`: without `repo`, every open pull you may read, oldest first, as `{ pulls, next_cursor }` (limit 1-200, default 50): `repo`, `number`, `title`, `check`, `verdict` (approved, changes_requested or none) and `gate` (what holds it, or null; the `why` module's cause); with `repo`, a repository's pulls, newest first, one brief line each: `number`, `title`, `author`, `head`, `check` (state), `approvals`, `changesRequested`, `mergeable` (null once closed); `state` open (default) or closed, `limit` 1-50 (default 20); no bodies, no diffs",
  description:
    "A repository's pulls, newest first; no `repo`: all open pulls you may read, oldest first.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      state: { type: "string", enum: ["open", "closed"] },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      cursor: { type: "string" },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    if (args["repo"] === undefined) return pile(ctx, user, args);
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

/** Every open pull the caller may read, oldest first, one page: no git, no per-pull query beyond the check. */
function pile(ctx: Ctx, user: User, args: Args): Answer {
  const db = ctx.app.db;
  if (args["state"] !== undefined && args["state"] !== "open")
    return bad("invalid", "without `repo` only open pulls are listed");
  const all = openPullPileRows(db);
  const repos = getReposByIds(db, [...new Set(all.map((x) => x.repoId))]);
  const readable = new Map<string, boolean>();
  const rows = all.filter((row) => {
    const repo = repos.get(row.repoId);
    if (repo === undefined) return false;
    let may = readable.get(row.repoId);
    if (may === undefined) readable.set(row.repoId, (may = canRead(db, repo, user)));
    return may && mayView(db, repo, row, user);
  });
  const page = pageRows(rows, (r) => r.id, args);
  if (!page.ok) return page;
  const { items, next_cursor } = page.value as { items: typeof rows; next_cursor: string | null };
  const pulls = pullsByIssueIds(db, items.map((r) => r.id));
  const reviews = reviewSummariesFor(db, pulls);
  const whys = whyPulls(ctx.app, pulls.map((pull) => ({ repo: repos.get(pull.repoId)!, pull })));
  return good({
    pulls: pulls.map((p, i) => {
      const repo = repos.get(p.repoId)!;
      const r = reviews.get(p.id);
      return {
        repo: `${repo.ownerName}/${repo.name}`,
        number: p.number,
        title: p.title,
        check: checkSummary(db, p.id, p.headOid).state,
        verdict: (r?.changesRequested ?? 0) > 0 ? "changes_requested" : (r?.approvals ?? 0) > 0 ? "approved" : "none",
        gate: whys[i]?.cause?.name ?? null,
        why: whys[i]?.cause?.says ?? whys[i]?.next?.why ?? null,
      };
    }),
    next_cursor,
  });
}
