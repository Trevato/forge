import { decideAsk } from "../../../actions/asks_decide.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "asks_decide",
  description:
    "Let the decider answer a hand-over (`item`: `parked:<id>`); only a sure set_aside clears.",
  inputSchema: {
    type: "object",
    properties: { item: { type: "string", maxLength: 80 } },
    required: ["item"],
  },
  writes: true,
  async run(ctx, user, args) {
    const done = await decideAsk(ctx.app, user, args["item"]);
    return done.ok ? good(done.value) : bad(done.error.code, done.error.message);
  },
};
