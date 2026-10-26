import { asksAnswer } from "../../../web/studio/asks.ts";
import { good, bad, type Tool, CHIP_ARGS, chipArgs } from "../shared.ts";

export const tool: Tool = {
  name: "asks",
  description:
    "What waits on you, most important first; saved filter applies",
  inputSchema: { type: "object", properties: { ...CHIP_ARGS } },
  writes: false,
  run(ctx, user, args) {
    const chips = chipArgs(ctx, args);
    if (chips && "error" in chips) return bad("invalid", chips.error);
    return good(asksAnswer(ctx, user, chips));
  },
};
