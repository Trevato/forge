import { changeDoor, reissueDoor } from "../../../spawn/door.ts";
import { good, bad, type Tool, str, REVEAL_ARG, LINK_KEPT, LINK_REVEALED } from "../shared.ts";

export const tool: Tool = {
  name: "claim_link",
  doc: "`{ name, action?, reveal? }`: `action` `revoke`/`undo` ends the link or restores it within 1 min; else a new claim link for an unclaimed child, only with `reveal: true`; the old stops. Admin",
  description: "A child's claim link: `reveal` a new one, or `action` revoke/undo.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      action: { enum: ["revoke", "undo"] },
      reveal: REVEAL_ARG,
    },
    required: ["name"],
  },
  writes: true,
  async run(ctx, user, args) {
    const action = args["action"];
    if (action === "revoke" || action === "undo") {
      const done = await changeDoor(ctx, user, str(args["name"]), action);
      return done.status >= 400 ? bad(String(done.body["error"]), String(done.body["message"])) : good(done.body);
    }
    if (args["reveal"] !== true)
      return good({ says: `Nothing changed. ${LINK_KEPT}`, reissued: false });
    const door = await reissueDoor(ctx, user, str(args["name"]));
    if (door.status >= 400)
      return bad(String(door.body["error"]), String(door.body["message"]));
    return good({ says: LINK_REVEALED, ...door.body });
  },
};
