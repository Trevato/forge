import { voteVariant } from "../../../actions/variants.ts";
import { mayView } from "../../../core/sealed.ts";
import { getPull } from "../../../core/pulls.ts";
import { VOTE_NOT_RECORDED } from "../../../actions/board_words.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";
import { ANSWER_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "variant",
  doc: "`{ repo, number, answer, reason? }`: like or dislike one pull among its variants (`answer` like or dislike); a later vote replaces the earlier; a dislike closes the pull with `reason`",
  description:
    "Like or dislike a pull among its variants; a later vote replaces; dislike closes it.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      answer: { type: "string", enum: ["like", "dislike"] },
      reason: { type: "string", maxLength: 200 },
    },
    required: ["repo", "number", "answer"],
  },
  writes: true,
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
    const answer = args["answer"];
    if (answer !== "like" && answer !== "dislike")
      return bad("invalid_answer", ANSWER_WORDS);
    const voted = voteVariant(
      ctx.app,
      user,
      repo,
      pull,
      answer,
      str(args["reason"]),
    );
    return voted.ok
      ? good({ answer, closed: voted.value.closed })
      : bad(voted.error, VOTE_NOT_RECORDED);
  },
};
