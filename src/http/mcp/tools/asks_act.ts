import { applyAsksBulk, previewAsksBulk } from "../../../actions/asks_bulk.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "asks_act",
  description:
    "Decide asks (`items`): dismiss, decline, ship, close (`reason`), mute, replan",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["dismiss", "decline", "mute", "ship", "close", "replan"] },
      items: { type: "array", items: { type: "string" }, maxItems: 100 },
      reason: { type: "string", maxLength: 300 },
      dryRun: { type: "boolean", description: "false to apply" },
    },
    required: ["action", "items"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const answer =
      args["dryRun"] === false
        ? await applyAsksBulk(ctx.app, user, args["action"], args["items"], args["reason"])
        : previewAsksBulk(ctx.app, user, args["action"], args["items"], args["reason"]);
    return answer.ok ? good(answer.value) : bad(answer.error.code, answer.error.message);
  },
};
