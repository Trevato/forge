import { holdAs, liftAs, MAX_REASON } from "../../../keeper/hold.ts";
import { bad, good, str, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "release_hold",
  doc: "`{ reason }` or `{ lift }`: hold the release keeper (#7557) with a reason, so it cuts nothing until the hold is lifted; or lift an owner hold by its id. A failed verify's hold is lifted by a verified release after a pull saying `release hold N` lands, not here. A person who may roll back, with an admin-scope token, never an agent",
  description: "Hold or release the release keeper's cuts (admin).",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string", maxLength: MAX_REASON }, lift: { type: "integer", minimum: 1 } },
  },
  writes: true,
  needsAdminScope: true,
  run(ctx, user, args) {
    const id = args["lift"];
    if (id !== undefined) {
      if (typeof id !== "number") return bad("invalid", "lift is a hold's id");
      const lifted = liftAs(ctx.app, user, id);
      return lifted.ok ? good({ lifted: lifted.value }) : bad(lifted.error, lifted.message);
    }
    const held = holdAs(ctx.app, user, str(args["reason"]));
    return held.ok ? good({ hold: held.value }) : bad(held.error, held.message);
  },
};
