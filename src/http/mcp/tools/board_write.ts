import { writeBoard } from "../../../actions/boards.ts";
import { good, type Tool, str, boardRefused, mayBoards, boardFailed } from "../shared.ts";

export const tool: Tool = {
  name: "board_write",
  doc: "`{ slug, board }` (person admins): write a whole board under a slug, made or replaced: `{ title, range, refresh, panels: [{ title, chart, query, w, h }] }`",
  description:
    "Write a whole board under a slug: {title, range, refresh, panels}.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", maxLength: 40 },
      board: { type: "object" },
    },
    required: ["slug", "board"],
  },
  writes: true,
  async run(ctx, user, args) {
    if (!mayBoards(user)) return boardRefused();
    const done = await writeBoard(ctx.app, user, str(args["slug"]), args["board"]);
    return done.ok ? good({ slug: str(args["slug"]), ...done.value }) : boardFailed(done.error);
  },
};
