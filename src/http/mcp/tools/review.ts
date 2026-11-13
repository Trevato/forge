import { mayView } from "../../../core/sealed.ts";
import { submitReview } from "../../../actions/pulls.ts";
import { originError } from "../../../web/pages/thread.ts";
import { reviewWords } from "../../../actions/review_words.ts";
import { getPull } from "../../../core/pulls.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "review",
  doc: "`{ repo, number, verdict, reason? }`: approve a pull (`approve`) or request changes (`changes`, with a `reason`), as the page does; a writer's or the crew's, and never your own pull",
  description:
    "Approve a pull, or request changes (`reason` required); your own pull is refused.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      verdict: { type: "string", enum: ["approve", "changes"] },
      reason: { type: "string", maxLength: 65536 },
    },
    required: ["repo", "number", "verdict"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const verdict = args["verdict"];
    if (verdict !== "approve" && verdict !== "changes")
      return bad("invalid", "verdict is approve or changes");
    const reason = str(args["reason"]);
    if (verdict === "changes" && reason === "")
      return bad("invalid", "say what to change (reason)");
    const n = args["number"];
    const pull =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getPull(ctx.app.db, repo.id, n)
        : undefined;
    if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
      return bad("no_such_pull", `no pull #${String(n)}`);
    const state = verdict === "approve" ? "approved" : "changes_requested";
    const sent = await submitReview(ctx.app, user, repo, pull, {
      state,
      ...(reason === "" ? {} : { body: reason }),
    });
    if (!sent.ok) {
      const error = sent.error;
      return bad(
        "refused",
        originError(error) ??
          (error === "self_review"
            ? reviewWords.selfReview
            : error === "forbidden"
              ? reviewWords.forbidden
              : error === "body_too_long"
                ? reviewWords.tooLong
                : error === "looks_required"
                  ? reviewWords.looksRequired
                  : "That review could not be recorded."),
      );
    }
    return good({
      says: verdict === "approve" ? "Approved." : "Changes requested.",
      url: `/${repo.ownerName}/${repo.name}/pulls/${pull.number}`,
    });
  },
};
