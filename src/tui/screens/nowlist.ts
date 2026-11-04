/**
 * Home's Now line as a screen, a site admin's (/now/:stage on the web): check,
 * review, land and live, `1`–`4` to switch, each listing what the word counts
 * from `readNowRows`, so the number is home's. Enter opens the row on the
 * web. Anyone else, and an agent, is offered nothing.
 */

import { mayReadNow, NOW_HOLDS, NOW_LISTED, NOW_STAGES, NOW_WORDS, readNowRows } from "../../flow/now_rows.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, openOnWeb, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export function nowScreen(f: Session, ctx: Ctx, first: (typeof NOW_STAGES)[number] = "check"): Screen {
  const state = new ListState();
  let stage = first;
  const read = () => (mayReadNow(f.user) ? readNowRows(f.db, stage) : { total: 0, rows: [] });
  const screen: Screen = {
    title: "Now",
    keys: [binding(["j", "k"], "move cursor"), binding(["1", "2", "3", "4"], "check, review, land, live"), binding(["enter"], "open on the web")],
    render(area, s) {
      const c = ctx.theme.c;
      const { total, rows } = read();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const words = NOW_STAGES.map((w) => (w === stage ? `[${NOW_WORDS[w]}]` : NOW_WORDS[w])).join("  ");
      const cut = total > rows.length ? ` Newest ${NOW_LISTED} shown.` : "";
      const text = mayReadNow(f.user) ? `${words}   ${total} · ${NOW_HOLDS[stage]}${cut}` : "Now is a site admin's.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const shown: ListRow[] = rows.map((r) => ({ title: r.title, secondary: `${r.repo} · ${r.note}`, meta: r.at.slice(0, 16).replace("T", " ") }));
      drawList(s, list!, c, state, shown);
    },
    key(e) {
      if (!mayReadNow(f.user)) return false;
      const { rows } = read();
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt) return false;
      const picked = NOW_STAGES[Number(e.key) - 1];
      if (picked !== undefined) {
        stage = picked;
        state.index = 0;
        state.offset = 0;
        return true;
      }
      if (e.key === "enter" && rows[state.index] !== undefined) {
        openOnWeb(f, ctx, rows[state.index]!.href, "That row");
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** The Now line's lists, as /now/:stage has them: a site admin's. */
export const entry: PaletteEntry = {
  id: "now",
  title: "Now",
  hint: "what check, review, land and live count, with the rows",
  after: ["boards"],
  offered: (session) => mayReadNow(session.user),
  run: (session, ctx) => ctx.push(nowScreen(session, ctx)),
};
