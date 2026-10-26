import { deleteBoard } from "../../../actions/boards.ts";
import { good, type Tool, str, boardRefused, mayBoards, boardFailed } from "../shared.ts";

export const tool: Tool = {
  name: "board_delete",
  doc: "`{ slug }` (person admins): delete a board by slug; its history keeps it",
  description:
    "Delete a board by slug (history keeps it). Person admins only.",
  inputSchema: {
    type: "object",
    properties: { slug: { type: "string", maxLength: 40 } },
    required: ["slug"],
  },
  writes: true,
  async run(ctx, user, args) {
    if (!mayBoards(user)) return boardRefused();
    const done = await deleteBoard(ctx.app, user, str(args["slug"]));
    return done.ok ? good({ deleted: str(args["slug"]) }) : boardFailed(done.error);
  },
};
