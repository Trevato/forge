import { mayView } from "../../../core/sealed.ts";
import { addCommentThrough } from "../../../actions/issues.ts";
import { getIssue } from "../../../core/issues.ts";
import { talk, TALK_WORDS } from "../../../actions/talk.ts";
import { WORDS_MAX } from "../../../core/fence.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "say",
  doc: "speak on an issue or a pull; a working builder hears it as its next step. With no `repo` or `number` it speaks to the forge's own agent (`forge talk`), which answers in `GET /api/v1/conversation/turns`",
  description:
    "Say something on an issue or pull; with no repo, to the forge's own agent.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      text: { type: "string", maxLength: 8000 },
    },
    required: ["text"],
  },
  writes: true,
  async run(ctx, user, args) {
    if (args["repo"] === undefined && args["number"] === undefined) {
      // The forge's own agent never wakes itself: its via token is refused.
      if (ctx.auth.through !== undefined) return bad("forbidden", "the forge's agent cannot start its own turn");
      const text = str(args["text"]);
      if (text.trim() === "" || text.length > WORDS_MAX) return bad("invalid_text", `text is 1 to ${WORDS_MAX} characters`);
      const talked = talk(ctx.app, user, text);
      if (!talked.ok) return bad(talked.error, TALK_WORDS[talked.error][1]);
      return good({ says: talked.value.how === "steered" ? "Said to the forge's agent, mid-answer." : "The forge's agent is answering; read it in GET /api/v1/conversation/turns." });
    }
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
