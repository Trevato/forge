import { mayView } from "../../../core/sealed.ts";
import { addCommentThrough } from "../../../actions/issues.ts";
import { getIssue } from "../../../core/issues.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "say",
  doc: "speak on an issue or a pull; a working builder hears it as its next step",
  description:
    "Say something on an issue or pull. A working builder hears it next, else the next run.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      text: { type: "string", maxLength: 8000 },
    },
    required: ["repo", "number", "text"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = getIssue(ctx.app.db, repo.id, Number(args["number"]));
    if (issue === undefined || !mayView(ctx.app.db, repo, issue, user))
      return bad("not_found", "no issue or pull by that number");
    const said = await addCommentThrough(
      ctx.app,
      user,
      repo,
      issue,
      str(args["text"]),
    );
    return said.ok
      ? good({ says: `Said on #${issue.number}.` })
      : bad("refused", "that could not be said here");
  },
};
