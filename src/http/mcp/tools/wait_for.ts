import { THREAD_SAYS } from "../../../actions/thread_words.ts";
import { dependencyWords, linkIssue } from "../../../actions/dependencies.ts";
import { stopWaiting } from "../../../actions/gate.ts";
import { good, bad, type Tool, APP_ARG, planRepo, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "wait_for",
  doc: "`{ app, issue, blockedBy, stop? }`: the issue waits for another, or stops with `stop: true`; the page's rules, and the answer carries the issue's URL",
  description: "An issue waits for another; `stop` ends it.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      issue: { type: "integer", minimum: 1 },
      blockedBy: { type: "integer", minimum: 1 },
      stop: { type: "boolean" },
    },
    required: ["app", "issue", "blockedBy"],
  },
  writes: true,
  run(ctx, user, args) {
    if (args["stop"] !== undefined && typeof args["stop"] !== "boolean")
      return bad("invalid_stop", "stop is true or false");
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = issueArg(ctx, repo, args, "issue");
    if ("ok" in issue) return issue;
    const blocker = issueArg(ctx, repo, args, "blockedBy");
    if ("ok" in blocker) return blocker;
    const stop = args["stop"] === true;
    const done = stop
      ? stopWaiting(ctx.app, user, repo, issue, blocker)
      : linkIssue(ctx.app, user, repo, issue, blocker);
    if (!done.ok)
      return bad(
        done.error,
        dependencyWords[done.error] ??
          THREAD_SAYS.planForbidden,
      );
    return good({
      says: `#${issue.number} ${stop ? "no longer waits" : "waits"} for #${blocker.number}.`,
      url: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${issue.number}`,
    });
  },
};
