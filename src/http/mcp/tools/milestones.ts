import { milestoneData, milestonesJson } from "../../../web/pages/milestones.ts";
import { good, bad, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "milestones",
  doc: "`{ app, issue? }`: how far each thing asked for is (and, with `issue`, whether you watch it: `watching`), from the dependency tree: the plan's limbs with their weights, or one milestone opened (who is building, what is blocked and on what, what merged in 7 days, an estimate, `closedPerDay` (14 days) and `paceDate`, and for an owner `spend`: dollars, changes landed ever, the costliest three issues)",
  description:
    "How far each ask is. With `app`: top-level limbs, done/total, building, recent merges.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      issue: {
        type: "integer",
        minimum: 1,
        description:
          "Issue number; limbs if absent.",
      },
    },
    required: ["app"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (args["issue"] === undefined)
      return good(await milestonesJson(ctx, repo));
    const number = args["issue"];
    const data =
      typeof number === "number" && Number.isInteger(number) && number > 0
        ? await milestoneData(ctx, repo, number)
        : undefined;
    return data === undefined
      ? bad(
          "not_a_milestone",
          "no issue by that number waits for others here",
        )
      : good(data);
  },
};
