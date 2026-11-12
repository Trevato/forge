/**
 * Refused first asks in the terminal (#11586): the last `REFUSED_SHOWN` first
 * asks the forge turned away, newest first, as `/forges/refused` lists them.
 * Gate is the page's (`mayReadRefusals`). One `listRefusals` call; read-only.
 */

import type { Database } from "bun:sqlite";
import { REFUSED_SHOWN, listRefusals, mayReadRefusals } from "../../core/first_ask_refusals.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** One line per refusal; empty for anyone the gate refuses. Control characters in a stranger's ask become spaces. */
export function refusedLines(session: Session, db: Database = session.app.db, now = Date.now()): string[] {
  if (!mayReadRefusals(session.user)) return [];
  return listRefusals(db, REFUSED_SHOWN, now).map((r) =>
    `${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")}  ${r.actorId ?? "no one"}  ${r.ask}  — ${r.words}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "),
  );
}

export function refusedScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "Refused first asks",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = refusedLines(session);
      const shown = lines.length === 0 ? ["No first ask has been refused."] : lines;
      drawLines(s, area, c, scroll, shown.map((text) => [{ text, style: style(c.fg, c.bg) }]));
      hitScroll(ctx, area, scroll, shown.length);
    },
    key(e) {
      if (scroll.key(e, refusedLines(session).length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "refused-asks",
  title: "Refused first asks",
  hint: `the last ${REFUSED_SHOWN} first asks turned away`,
  after: ["system"],
  offered: (session) => mayReadRefusals(session.user),
  run: (session, ctx) => ctx.push(refusedScreen(session, ctx)),
};
