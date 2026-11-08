import { headroomPct, setHeadroom } from "../../../core/standing.ts";
import { SUBSCRIPTION_WORDS } from "../../../core/subscriptions_words.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "subscription_headroom",
  doc: "`{ id, percent }`: how much of each 5-hour and weekly window the crew leaves for people on one account, a whole percent, as the Subscriptions page does; answers `{ id, percent, says }`; a forge admin with an admin token",
  description: "Admin: set the % of each window the crew leaves for people.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, percent: { type: "integer" } },
    required: ["id", "percent"],
  },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  run(ctx, _user, args) {
    const id = args["id"];
    const percent = args["percent"];
    if (typeof id !== "string" || id === "" || id.length > 64)
      return bad("invalid", "id is the subscription's id");
    // The page's own check: the form's text through headroomPct.
    const pct =
      typeof percent === "number" || typeof percent === "string" ? headroomPct(String(percent)) : undefined;
    if (pct === undefined) return bad("invalid", SUBSCRIPTION_WORDS.headroom_range);
    if (!setHeadroom(ctx.app.db, id, pct)) return bad("not_found", SUBSCRIPTION_WORDS.not_found);
    return good({ id, percent: pct, says: `The crew now leaves ${pct}% of each window for people.` });
  },
};
