import { liftHold } from "../../../actions/gate.ts";
import { THREAD_SAYS } from "../../../actions/thread_words.ts";
import { good, bad, type Tool, APP_ARG, planRepo, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "lift",
  doc: "`{ app, issue }`: let an issue out from behind the Later gate, as the page's Lift does; its `Later` label goes with it, and the answer carries the issue's URL",
  description: "Lift an issue out from behind the Later gate.",
  inputSchema: {
    type: "object",
    properties: { app: APP_ARG, issue: { type: "integer", minimum: 1 } },
    required: ["app", "issue"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = issueArg(ctx, repo, args, "issue");
    if ("ok" in issue) return issue;
    const lifted = liftHold(ctx.app, user, repo, issue);
    if (!lifted.ok)
      return bad(
        lifted.error,
        lifted.error === "not_held" ? `#${issue.number} is not behind the Later gate.` : THREAD_SAYS.planForbidden,
      );
    return good({
      says: `#${issue.number} is lifted from behind the Later gate.`,
      url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${issue.number}`,
    });
  },
};
