import { askEstimate, estimateIssue, recordEstimate } from "../../../actions/estimates.ts";
import { bad, good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";
import { mayView } from "../../../core/sealed.ts";

export const tool: Tool = {
  name: "estimate",
  doc: "`{ repo, issue, event?, p50?, p90?, basis? }`: with no times, the base rate for that issue from the forge's own history (p50/p90 instants and durations per event, sample size, one line of basis, what is true now, and your scorecard); with `event` (`pull_opened`, `merged`, `live`, `done`: the issue closed and stayed closed 24 h, or its last pull is live), `p50` and `p90` (future instants, p50 ≤ p90) it records an estimate, which the forge resolves when the event happens and a new one supersedes",
  description: "Ask an issue's base rate, or record `event` with `p50`, `p90` (instants) and `basis`.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      issue: { type: "integer", minimum: 1 },
      event: { type: "string", enum: ["pull_opened", "merged", "live", "done"] },
      p50: { type: "string", maxLength: 40 },
      p90: { type: "string", maxLength: 40 },
      basis: { type: "string", maxLength: 300 },
    },
    required: ["repo", "issue"],
  },
  writes: true,
  readsWithout: "event",
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = estimateIssue(ctx.app, repo, args["issue"] as number);
    if (issue === undefined || !mayView(ctx.app.db, repo, issue, ctx.auth.user))
      return bad("no_such_issue", `no issue #${String(args["issue"])}`);
    if (args["event"] === undefined) return good(askEstimate(ctx.app, user, repo, issue));
    const made = recordEstimate(ctx.app, user, repo, issue, {
      event: args["event"],
      p50: args["p50"],
      p90: args["p90"],
      basis: args["basis"],
    });
    return made.ok ? good({ says: `Recorded: ${made.value.base.basis}`, ...made.value }) : bad(made.error.kind, made.error.message);
  },
};
