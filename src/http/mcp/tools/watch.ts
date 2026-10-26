import { watchMilestone } from "../../../actions/watches.ts";
import { MILESTONE_WATCH_PERSON_ONLY } from "../../../actions/board_words.ts";
import { good, bad, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "watch",
  doc: "`{ app, issue, watch? }`: watch a milestone, or stop with `watch: false`: one item in your feed that follows it, and one push to your phone when it lands",
  description:
    "Watch a milestone, or stop (`watch: false`): one feed item; your phone is told once when it lands.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      issue: {
        type: "integer",
        minimum: 1,
        description: "Issue number.",
      },
      watch: {
        type: "boolean",
        description: "false to stop.",
      },
    },
    required: ["app", "issue"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const number = args["issue"];
    const set =
      typeof number === "number" && Number.isInteger(number) && number > 0
        ? watchMilestone(ctx.app, user, repo, number, args["watch"] !== false)
        : undefined;
    if (set === undefined || (!set.ok && set.error === "not_found"))
      return bad(
        "not_a_milestone",
        "no issue by that number waits for others here",
      );
    return set.ok
      ? good(set.value)
      : bad("forbidden", MILESTONE_WATCH_PERSON_ONLY);
  },
};
