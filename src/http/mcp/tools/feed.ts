import { FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX, parseCursor, readFeed } from "../../../feed/feed.ts";
import { good, bad, type Tool, CHIP_ARGS, chipArgs, str } from "../shared.ts";

export const tool: Tool = {
  name: "feed",
  doc: "`{ limit?, cursor? }`: your home timeline — tells, replies, runs, changes and looks — ranked, with who, what, why and a link; the same items as `GET /api/v1/feed`",
  description:
    "Your ranked home timeline across visible apps; `cursor` pages; saved filter (`feed_chips`) applies.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: FEED_LIMIT_MAX },
      cursor: { type: "string" },
      ...CHIP_ARGS,
    },
  },
  writes: false,
  run(ctx, user, args) {
    const chips = chipArgs(ctx, args);
    if (chips && "error" in chips) return bad("invalid", chips.error);
    const raw = args["limit"];
    const limit = raw === undefined ? FEED_LIMIT_DEFAULT : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_LIMIT_MAX)
      return bad("invalid", `limit is 1 to ${FEED_LIMIT_MAX}`);
    const given = args["cursor"];
    const cursor = given === undefined ? undefined : parseCursor(str(given));
    if (given !== undefined && cursor === undefined)
      return bad("invalid", "that cursor was not issued here");
    return good(
      readFeed(ctx.app.db, user, {
        limit,
        ...(chips === undefined ? {} : { chips }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  },
};
