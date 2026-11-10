/**
 * Pages over their real-visitor budget, the owner's (#10536): one line per
 * page whose p95 server time or first paint, as browsers reported them in the
 * last hour, misses `PAGE_BUDGET` — the lines `/system` shows. Gate is
 * `/system`'s: a forge admin who is a person. The palette offers it only when
 * a page is over, so a fast forge has nothing here. Read-only.
 */

import type { Database } from "bun:sqlite";
import { slowPageLine, slowPages } from "../../perf/watch.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

/** A line per slow page; empty for anyone the gate refuses and when every page is fast. */
export function slowPageLines(session: Session, db: Database = session.app.db, now = Date.now()): string[] {
  return mayRead(session) ? slowPages(db, now).map(slowPageLine) : [];
}

export function slowPagesScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "Pages over budget",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = slowPageLines(session);
      drawLines(s, area, c, scroll, lines.map((text) => [{ text, style: style(c.fg, c.bg) }]));
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, slowPageLines(session).length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "slow-pages",
  title: "Pages over budget",
  hint: "real visitors' slow pages, last hour",
  after: ["stalls", "system"],
  offered: (session) => slowPageLines(session).length > 0,
  run: (session, ctx) => ctx.push(slowPagesScreen(session, ctx)),
};
