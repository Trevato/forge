import { listPinned as listPinnedPanels, movePinned, pinPanel, unpinPanel } from "../../../actions/board-pins.ts";
import { good, bad, type Tool, boardRefused, mayBoards } from "../shared.ts";
import { PIN_OP_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "board_pins",
  doc: "`{ op?, slug?, title?, by? }` (person admins): without `op`, the panels pinned to your home (`slug`, `title`); `pin` or `unpin` a panel by board `slug` and panel `title`, or `move` it up or down with `by` (-1 or 1)",
  description:
    "The panels pinned to the caller's home (person admins). No `op` lists them.",
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["pin", "unpin", "move"] },
      slug: { type: "string", maxLength: 40 },
      title: { type: "string", maxLength: 80 },
      by: { type: "integer", enum: [-1, 1] },
    },
  },
  writes: true,
  async run(ctx, user, args) {
    if (!mayBoards(user)) return boardRefused();
    const op = args["op"];
    if (op === undefined) {
      const listed = await listPinnedPanels(ctx.app, user);
      return listed.ok ? good({ pins: listed.value.map((p) => ({ slug: p.slug, title: p.title })) }) : boardRefused();
    }
    const [slug, title] = [args["slug"], args["title"]];
    const done =
      op === "pin" ? await pinPanel(ctx.app, user, slug, title)
      : op === "unpin" ? unpinPanel(ctx.app, user, slug, title)
      : op === "move" ? movePinned(ctx.app, user, slug, title, args["by"])
      : undefined;
    if (!done) return bad("invalid", PIN_OP_WORDS);
    return done.ok ? good({ ...done.value }) : bad(done.error, "that could not be pinned");
  },
};
