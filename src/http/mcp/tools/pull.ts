import { mayView } from "../../../core/sealed.ts";
import { pullProposalOf } from "../../../core/proposal_token.ts";
import { resolveOid } from "../../../git/merge.ts";
import { getPull, pullDir, pullMergeState } from "../../../core/pulls.ts";
import { previewEnv } from "../../../apps/data.ts";
import { checkStale } from "../../../checks/stale.ts";
import { checkSummary } from "../../../core/runs.ts";
import { appView } from "../../../actions/apps.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "pull",
  doc: "`{ repo, number }`: a pull's title, state, head and base, and for an open pull whether it merges into the base's current head (`mergeable`) and the paths that stop it (`conflicts`), and `check: { state, baseOid }`: the latest check's state and the base tip it was merged with (empty when it merged nothing); `mergeable` and `conflicts` are the same fields as `GET …/pulls/:number`, `check` is `state` and `run.baseOid` from `GET …/pulls/:number/checks`; draws the `ui://forge/pull` card: `#N title`, state with check and conflicts while open, `head → base` linked to the pull, and the preview link when the pull has an environment",
  description:
    "Read a pull: title, state, head, base; open: `mergeable`, `conflicts`, `proposal`, `check`.",
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
    const answer = good({
      number: pull.number,
      title: pull.title,
      state: pull.mergedAt !== null ? "merged" : pull.state,
      base: pull.baseBranch,
      head: pull.headBranch,
      proposal: pullProposalOf(ctx.app.db, pull.id) ?? null,
      check: { state: check.state, baseOid: check.run?.baseOid ?? "" },
      checkStale: stale,
      ...(state ?? {}),
    });
    // What the card needs and the text does not say: where the pull lives
    // and its preview, only when that environment exists — the pull page's
    // door, `previewCard`, reads the same `appView`.
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
