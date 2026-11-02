import { confirmIssue } from "../../../actions/dependencies.ts";
import { good, bad, type Tool, APP_ARG, planRepo, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "confirm_wait",
  doc: "`{ app, issue, blocker }`: a person says `issue` may go ahead although `blocker` closed as dropped or split; the API's confirm action, so writers only and never the crew",
  description:
    "Let an issue go ahead though its blocker closed dropped or split.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      issue: { type: "integer" },
      blocker: { type: "integer" },
    },
    required: ["app", "issue", "blocker"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = issueArg(ctx, repo, args, "issue");
    if ("ok" in issue) return issue;
    const blocker = issueArg(ctx, repo, args, "blocker");
    if ("ok" in blocker) return blocker;
    const done = confirmIssue(ctx.app, user, repo, issue, blocker);
    if (!done.ok)
      return bad(
        done.error,
        "You need write access, and not a place on the crew, to confirm a wait.",
      );
    return good({
      says: `#${issue.number} may go ahead without #${blocker.number}.`,
      url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${issue.number}`,
    });
  },
};
