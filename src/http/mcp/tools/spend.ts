import { reportSpend } from "../../../actions/returns.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "spend",
  description:
    "Report what your session spent outside forge runs: who, model, tokens or dollars, issue.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      who: { type: "string", maxLength: 100 },
      model: { type: "string", maxLength: 100 },
      tokensIn: { type: "integer", minimum: 0 },
      tokensOut: { type: "integer", minimum: 0 },
      usd: { type: "number", minimum: 0, maximum: 10000 },
      issue: { type: "integer", minimum: 1 },
      note: { type: "string", maxLength: 500 },
    },
    required: ["repo", "who"],
  },
  doc:
    "`{ repo, who, model?, tokensIn?, tokensOut?, usd?, issue?, note? }`: report what your session spent outside forge runs; `who` and some spend (tokens or `usd`) are required; answers the entry's `id` and `usd`",
  writes: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const made = reportSpend(ctx.app, user, repo, args);
    if (made.ok) return good({ id: made.value.id, usd: made.value.usd });
    return made.error === "invalid"
      ? bad("invalid", "who, and some spend: tokensIn, tokensOut or usd")
      : bad("not_found", "no such app or repository (owner/name)");
  },
};
