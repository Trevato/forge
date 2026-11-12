import { scopeAllows } from "../../../core/tokens.ts";
import { detachFromParent, detachJob, detachPlanWords } from "../../../actions/detach.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "detach",
  doc: "`{ repo, dryRun? }`: detach a fork from its parent — repack so it owns its objects, drop the alternates link, forget the parent; planned first (`dryRun` is true unless `false`); the repack runs on its own, so call again to read its `phase` (`repacking`, `failed`) until the fork has no `parent`; only the repository's admin with an admin token, never an agent",
  description: "Detach a fork from its parent. Plans first; admin token.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      dryRun: { type: "boolean" },
    },
    required: ["repo"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const dryRun = args["dryRun"] !== false;
    if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "detaching needs an admin token");
    const job = detachJob(repo.id);
    const phase = job === undefined ? null : { phase: job.phase, startedAt: job.startedAt, message: job.message };
    if (repo.forkParentId === null && job === undefined)
      return good({ parent: null, says: "No parent: this repository is not a fork, or is already detached." });
    const planned = await detachFromParent(ctx.app, user, repo, dryRun);
    if (!planned.ok) {
      if (planned.error === "running")
        return good({ ...phase, says: "A detach is already running; call again to see it finish." });
      if (planned.error === "not_a_fork")
        return good({ parent: null, says: "No parent: this repository is not a fork, or is already detached." });
      return bad("forbidden", "only an admin of this repository detaches it");
    }
    return good({
      ...planned.value,
      ...(phase === null ? {} : { last: phase }),
      says: dryRun
        ? `This is the plan; nothing changed. ${detachPlanWords(planned.value)} Send dryRun: false to detach.`
        : "Detaching: the repack runs on its own. Call again to see it finish.",
    });
  },
};
