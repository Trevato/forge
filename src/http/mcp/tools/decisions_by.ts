import { isDecisionsBy } from "../../../core/repos.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { setDecisionsBy } from "../../../actions/repos.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "decisions_by",
  doc: "`{ repo, by?, dryRun? }`: the standing rule for a repository's hand-overs (`me`, `decider`, `decider_tell`); with `by`, planned first (`dryRun` is true unless `false`); set only by the app's admin with an admin token, never an agent",
  description:
    "Who decides parked hand-over cards: `me`, `decider`, `decider_tell`. No `by` reads.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      by: { type: "string", enum: ["me", "decider", "decider_tell"] },
      dryRun: {
        type: "boolean",
        description: "false to apply",
      },
    },
    required: ["repo"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const by = args["by"];
    if (by === undefined) return good({ by: repo.decisionsBy });
    if (!isDecisionsBy(by))
      return bad("bad_action", "`by` is me, decider or decider_tell");
    const dryRun = args["dryRun"] !== false;
    if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "setting the standing rule needs an admin token");
    const set = await setDecisionsBy(ctx.app, user, repo, by, dryRun);
    if (!set.ok)
      return bad("forbidden", "only an admin of this app sets its standing rule");
    return good({
      ...set.value,
      says: dryRun
        ? `This is the plan; nothing changed. Decisions go by "${set.value.was}" now; send dryRun: false to make it "${set.value.by}".`
        : `Decisions here now go by "${set.value.by}".`,
    });
  },
};
