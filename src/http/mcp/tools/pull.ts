import { mayView } from "../../../core/sealed.ts";
import { pullProposalOf } from "../../../core/proposal_token.ts";
import { resolveOid } from "../../../git/merge.ts";
import { getPull, pullDir, pullMergeState } from "../../../core/pulls.ts";
import { previewEnv } from "../../../apps/data.ts";
import { checkStale } from "../../../checks/stale.ts";
import { checkSummary } from "../../../core/runs.ts";
import { nextOfPull } from "../../../flow/next_actor.ts";
import { stepOfPull } from "../../../flow/path.ts";
import { appView } from "../../../actions/apps.ts";
import { countThread, EMBEDDED_COMMENTS, listComments } from "../../../core/issues.ts";
import { landingLine } from "../../../flow/landing_line.ts";
import { pullLooks } from "../../../looks/readable.ts";
import { isCrew } from "../../../core/agents.ts";
import { markReaders } from "../../../crew/direct.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "pull",
  doc: "`{ repo, number }`: a pull's title, state, head and base, and for an open pull whether it merges into the base's current head (`mergeable`) and the paths that stop it (`conflicts`), and `next: { who, why }` (open only; who acts next: builder, reviewer, queue or person), `step: { step, why, done }` (check, review, land or live; null once closed unlanded), and `comments` (the newest 50: author, body, at, `untrusted` on an outsider's), `commentsTotal` and `commentsNext` (older: `GET …/issues/:number/comments?cursor=`), and `looks` (newest first: `{ id, width, says, by, commit, url, at }`, the same as `GET …/pulls/:number/looks`), and `eta: { minutes, says }` (approved open pull only, else null), and `check: { state, baseOid }`: the latest check's state and the base tip it was merged with (empty when it merged nothing); `mergeable` and `conflicts` are the same fields as `GET …/pulls/:number`, `check` is `state` and `run.baseOid` from `GET …/pulls/:number/checks`; draws the `ui://forge/pull` card: `#N title`, state with check and conflicts while open, `head → base` linked to the pull, and the preview link when the pull has an environment",
  description:
    "A pull: title, state, head, base; open: `mergeable`, `conflicts`, `checkStale`, `check`.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
    },
    required: ["repo", "number"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const n = args["number"];
    const pull =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getPull(ctx.app.db, repo.id, n)
        : undefined;
    if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
      return bad("no_such_pull", `no pull #${String(n)}`);
    const dir = await pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);
    const state = await pullMergeState(dir, pull);
    const check = checkSummary(ctx.app.db, pull.id, pull.headOid);
    const stale =
      pull.state === "open" &&
      pull.mergedAt === null &&
      checkStale(check.run, await resolveOid(dir, `refs/heads/${pull.baseBranch}`));
    const db = ctx.app.db;
    // Marked only for a crew agent, as the issue and the API do.
    const marking = user.kind === "agent" && isCrew(db, repo.id, user.id);
    const rows = listComments(db, pull.id, { newest: true, limit: EMBEDDED_COMMENTS });
    const comments = marking ? markReaders(db, repo, rows) : rows;
    const total = countThread(db, pull.id);
    const answer = good({
      comments: comments.map((c) => ({
        author: c.authorName,
        body: c.body,
        at: c.createdAt,
        ...("untrusted" in c && c.untrusted !== undefined ? { untrusted: true } : {}),
      })),
      commentsTotal: total,
      commentsNext: comments.length > 0 && comments.length < total ? comments[0]!.id : null,
      looks: pullLooks(ctx.app, repo, pull, user),
      number: pull.number,
      title: pull.title,
      state: pull.mergedAt !== null ? "merged" : pull.state,
      base: pull.baseBranch,
      head: pull.headBranch,
      eta: landingLine(ctx.app.db, pull, repo.id),
      proposal: pullProposalOf(ctx.app.db, pull.id) ?? null,
      check: { state: check.state, baseOid: check.run?.baseOid ?? "" },
      checkStale: stale,
      next: nextOfPull(ctx.app.db, pull, {
        headOid: pull.headOid,
        conflicts: state?.conflicts?.length ?? 0,
      }),
      step: stepOfPull(ctx.app.db, repo, pull, {
        headOid: pull.headOid,
        conflicts: state?.conflicts?.length ?? 0,
      }),
      ...(state ?? {}),
    });
    // What the card needs and the text does not say: where the pull lives
    // and its preview, only when that environment exists — the pull page's
    // door, `previewBlock`, reads the same `appView`.
    const view = appView(ctx.app, user, repo);
    const env = view.ok
      ? view.value.environments.find((e) => e.env === previewEnv(pull.number))
      : undefined;
    return {
      ...answer,
      card: {
        repo: `${repo.ownerName}/${repo.name}`,
        ...(env === undefined ? {} : { preview: env.url }),
      },
    };
  },
};
