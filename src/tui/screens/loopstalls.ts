/**
 * Main-thread stalls in the terminal, the owner's (#9016): the last hour's
 * top routes by milliseconds the loop was held past 250 ms, with
 * /api/v1/telemetry/flow always listed — the rows `/system` and `/metrics`
 * read (`stallHour`). The gate is `/system`'s: a forge admin who is a person.
 * Read-only.
 */

import { stallHour } from "../../metrics/stalls.ts";
import type { RouteStall } from "../../perf/loop.ts";
import { loopWatch } from "../../perf/live.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad } from "../term/width.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

/** The header, then a route a row; empty for anyone the gate refuses. */
export function stallLines(session: Session, rows: readonly RouteStall[] = stallHour(loopWatch.tally(performance.now()))): string[] {
  if (!mayRead(session)) return [];
  const col = (s: string) => pad(s, 10, "right");
  return [
    `${pad("Route (last hour)", 40)}${col("Stall ms")}${col("Stalls")}`,
    ...rows.map((r) => `${pad(r.route, 40)}${col(String(Math.round(r.ms)))}${col(String(r.count))}`),
  ];
}

export function stallsScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "Main-thread stalls",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = stallLines(session);
      const spans = lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, stallLines(session).length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "stalls",
  title: "Main-thread stalls",
  hint: "the last hour's stall ms by route",
  after: ["system"],
  offered: mayRead,
  run: (session, ctx) => ctx.push(stallsScreen(session, ctx)),
};
