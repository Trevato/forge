import { reissueDoor } from "../../../spawn/door.ts";
import { good, bad, type Tool, str, REVEAL_ARG, LINK_KEPT, LINK_REVEALED } from "../shared.ts";

export const tool: Tool = {
  name: "claim_link",
  doc: "`{ name, reveal? }`: a new claim link for a child you spawned that nobody has claimed; the old one stops working. An admin's, and only `reveal: true` makes it",
  description:
    "A new claim link for an unclaimed child forge, only with `reveal: true`; the old stops.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      reveal: REVEAL_ARG,
    },
    required: ["name"],
  },
  writes: true,
  async run(ctx, user, args) {
    if (args["reveal"] !== true)
      return good({ says: `Nothing changed. ${LINK_KEPT}`, reissued: false });
    const door = await reissueDoor(ctx, user, str(args["name"]));
    if (door.status >= 400)
      return bad(String(door.body["error"]), String(door.body["message"]));
    return good({ says: LINK_REVEALED, ...door.body });
  },
};
