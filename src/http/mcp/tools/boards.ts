import { listAllBoards, showBoard } from "../../../actions/boards.ts";
import { panelData, parseWindow } from "../../../boards/panel_data.ts";
import { panelNow } from "../../../boards/panel_now.ts";
import { good, bad, type Tool, str, boardRefused, mayBoards, boardFailed } from "../shared.ts";

export const tool: Tool = {
  name: "boards",
  doc: "`{ slug?, panel?, from?, to?, step? }` (person admins): without `slug`, lists the forge's boards (slug, title, range, refresh, panels); with `slug`, that board (the `ui://forge/board` card); with `panel` (place from 0, up to 23), that panel's data over the `from`/`to` window and `step`",
  description:
    "The forge's boards for person admins: slug, title, range, refresh and panels.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", maxLength: 40 },
      panel: { type: "integer", minimum: 0, maximum: 23, description: "Panel from 0." },
      from: { type: "string", maxLength: 64 },
      to: { type: "string", maxLength: 64 },
      step: { type: "string", maxLength: 16, description: "With panel: bucket seconds, or 5m." },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    if (!mayBoards(user)) return boardRefused();
    if (args["slug"] === undefined) {
      const listed = await listAllBoards(ctx.app, user);
      return listed.ok
        ? good({ boards: listed.value.map((b) => ({ slug: b.slug, ...b.board })) })
        : boardFailed(listed.error);
    }
    const shown = await showBoard(ctx.app, user, str(args["slug"]));
    if (!shown.ok) return boardFailed(shown.error);
    if (args["panel"] === undefined) {
      const values = shown.value.panels.slice(0, 8).map((p) => panelNow(ctx.app.db, shown.value, p));
      return { ...good({ slug: str(args["slug"]), ...shown.value }), card: { values } };
    }
    const index = args["panel"];
    const panel = typeof index === "number" && Number.isInteger(index) ? shown.value.panels[index] : undefined;
    if (!panel) return bad("not_found", "that board has no panel there");
    const asked = new URLSearchParams();
    for (const k of ["from", "to", "step"]) {
      const v = args[k];
      if (v !== undefined) asked.set(k, typeof v === "number" ? String(v) : str(v));
    }
    const window = parseWindow(asked);
    if (!window.ok) return bad("invalid_window", window.error);
    const data = panelData(ctx.app.db, shown.value, panel, window.window);
    if (!data.ok) return bad("bad_query", data.error);
    const { ok: _, ...out } = data;
    return good({ board: str(args["slug"]), panel: index, title: panel.title, chart: panel.chart, ...out });
  },
};
