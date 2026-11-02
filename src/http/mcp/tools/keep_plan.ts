import { PLAN_SHAPE, setPlan } from "../../../actions/run_plan.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, issueArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "keep_plan",
  doc: "`{ repo, number, items, ask? }`: replace the plan checklist on an issue whole (`items`: up to 12 of `{ text, done? }`; an empty list clears it); `ask` is what you need a person to answer, and shows the run as needing input; the same as `PUT …/issues/:number/plan`; answers the plan",
  description:
    "Keep a short plan checklist on your issue, replaced whole each time.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      items: {
        type: "array",
        maxItems: 12,
        items: {
          type: "object",
          properties: { text: { type: "string", maxLength: 120 }, done: { type: "boolean" } },
          required: ["text"],
        },
      },
      ask: { type: "string", maxLength: 300 },
    },
    required: ["repo", "number", "items"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = issueArg(ctx, repo, args, "number");
    if ("ok" in issue) return issue;
    const set = setPlan(ctx.app, user, repo, issue, { items: args["items"], ask: args["ask"] });
    if (!set.ok)
      return set.error === "invalid" ? bad("invalid", PLAN_SHAPE) : bad(set.error, "this plan is not yours to set");
    return good({ says: `Plan on #${issue.number}: ${set.value.items.filter((i) => i.done).length} of ${set.value.items.length} done.`, plan: set.value });
  },
};
