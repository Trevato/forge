import { FEED_LIMIT_DEFAULT, FEED_LIMIT_MAX, parseCursor, readFeed } from "../../../feed/feed.ts";
import { CURSOR_NOT_ISSUED } from "../../../actions/feed_words.ts";
import { feedDigest } from "../../../web/studio/since.ts";
import { good, bad, type Tool, CHIP_ARGS, chipArgs, str } from "../shared.ts";

export const tool: Tool = {
  name: "feed",
  doc: "`{ limit?, cursor? }`: your home timeline — tells, replies, runs, changes and looks — ranked, with who, what, why and a link; the same items as `GET /api/v1/feed`; `digest` (first page only) is home's \"Since you were here\" card, `{ heading, lines: [{ repo, says, href }] }` or null; `quietRuns` counts agent runs of the last 24 h that pushed, opened or said nothing, which the timeline leaves out; an item with `lines: [{ text, link }]` and `more` is a folded burst (3+ issues one author opened in one repository within 2 minutes: `planned N issues in owner/name`, linking to its map) — `lines` are the first three, `more` the rest",
  description:
    "Your ranked home timeline; `cursor` pages; saved filter applies.",
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
      return bad("invalid", CURSOR_NOT_ISSUED);
    const page = readFeed(ctx.app.db, user, {
      limit,
      ...(chips === undefined ? {} : { chips }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    return good({ ...page, ...(cursor === undefined ? { digest: feedDigest(ctx.app.db, user, Date.now()) } : {}) });
  },
};
