import { readScorecards } from "../../../actions/scorecard.ts";
import { ADMIN_WORDS } from "../../../actions/admin_words.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "scorecard",
  description:
    "Crew scorecard (forge admin): per agent, all time and 30 days.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  doc: "(forge admin) no input: the crew's scorecard per agent, all time and 30 days: landed, review rounds, red rate, reverts; week {merged, returned, cost}",
  adminOnly: true,
  run(ctx, user) {
    const card = readScorecards(ctx.app, user);
    return card ? good(card) : bad("forbidden", ADMIN_WORDS.scorecard);
  },
};
