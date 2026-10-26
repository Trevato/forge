import { readScorecards } from "../../../actions/scorecard.ts";
import { ADMIN_WORDS } from "../../../actions/admin_words.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "scorecard",
  description:
    "Crew scorecard (forge admin): per agent, all time and 30 days: landed, rounds, red rate, reverts.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  adminOnly: true,
  run(ctx, user) {
    const card = readScorecards(ctx.app, user);
    return card ? good(card) : bad("forbidden", ADMIN_WORDS.scorecard);
  },
};
