import { editIssue, TAKEN_UP } from "../../../actions/issues.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "edit",
  doc: "`{ repo, number, title?, body? }`: a new title or body for an issue or a pull: its author's, or a writer's; an agent edits only what it wrote",
  description:
    "Retitle or rewrite an issue or pull: yours, or where you write; an agent only its own.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      title: { type: "string", maxLength: 256 },
      body: { type: "string", maxLength: 65536 },
    },
    required: ["repo", "number"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    // The same door the plan tools use for an issue by number, so what
    // it comes to refuse (a sealed one, say) is refused here too.
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    const edited = editIssue(ctx.app, user, repo, issue, {
      title: typeof args["title"] === "string" ? args["title"] : undefined,
      body: typeof args["body"] === "string" ? args["body"] : undefined,
    });
    if (!edited.ok)
      return bad(
        edited.error,
        edited.error === "forbidden"
          ? "only the author, or a person who writes here, edits this"
          : edited.error === "taken_up"
            ? TAKEN_UP
            : edited.error === "nothing_to_change"
            ? "send a title, a body, or both"
            : "that could not be changed",
      );
    return good({
      says: `Edited #${issue.number}: ${edited.value.title}`,
      number: issue.number,
      title: edited.value.title,
    });
  },
};
