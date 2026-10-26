import { undoDecideAsk } from "../../../actions/asks_decide.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "asks_undecide",
  description:
    "Put a set-aside card back on your board, within a day. `id` from `asks_decide`.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", maxLength: 80 } },
    required: ["id"],
  },
  writes: true,
  run(ctx, user, args) {
    const done = undoDecideAsk(ctx.app, user, args["id"]);
    return done.ok ? good(done.value) : bad(done.error.code, done.error.message);
  },
};
