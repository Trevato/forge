import { decideAsk } from "../../../actions/asks_decide.ts";
import { giveBack } from "../../../actions/give_back.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "asks_decide",
  doc: "`{ item, give_back? }`: let the decider answer a parked hand-over (`parked:<id>`); with `give_back`, give a hand-over back to the crew instead (`handover:<id>`, or `assigned:<id>` for a pull a pass gave up on and assigned to you, whose ask carries the pass's reason): it is assigned to the builder that last worked on it and a comment says so; the same as the card's **Give back to the crew** and `POST /api/v1/asks/give-back`",
  description:
    "Answer a hand-over: the decider (`parked:<id>`), or `give_back` to its builder (`handover:`/`assigned:<id>`)",
  inputSchema: {
    type: "object",
    properties: { item: { type: "string", maxLength: 80 }, give_back: { type: "boolean" } },
    required: ["item"],
  },
  writes: true,
  async run(ctx, user, args) {
    if (args["give_back"] === true) {
      const back = giveBack(ctx.app, user, args["item"]);
      return back.ok ? good(back.value) : bad(back.error.code, back.error.message);
    }
    const done = await decideAsk(ctx.app, user, args["item"]);
    return done.ok ? good(done.value) : bad(done.error.code, done.error.message);
  },
};
