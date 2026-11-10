/**
 * Main-thread stalls in the terminal, the owner's (#9016): the last hour's
 * top routes by milliseconds the loop was held past 200 ms, with
 * /api/v1/telemetry/flow always listed — the rows `/system` and `/metrics`
 * read (`stallHour`); then, as /system draws them (#11069), the last hour's
 * worst single stalls — what ran, its ms, and when, in UTC — only when there
 * is one. The gate is `/system`'s: a forge admin who is a person. Read-only.
 */

import { stallHour } from "../../metrics/stalls.ts";
import { HOUR_MS, type RouteStall } from "../../perf/loop.ts";
import { loopWatch, stallBlame } from "../../perf/live.ts";
import { WORST_STALLS, type BlamedStall } from "../../perf/stall_blame.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad } from "../term/width.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

/** The last hour's worst single stalls and one instant on both clocks, as /system reads them. */
export interface WorstNow {
  readonly rows: readonly BlamedStall[];
  /** The instant on the watcher's clock (`performance.now`). */
  readonly mono: number;
  /** The same instant on the wall clock, ms since the epoch. */
  readonly wall: number;
}

function worstNow(): WorstNow {
  const mono = performance.now();
  return { rows: stallBlame.worst(mono, HOUR_MS, WORST_STALLS), mono, wall: Date.now() };
}

/**
 * The header, then a route a row; then, when the hour had any, a blank line and
 * the worst single stalls. A stall's wall time is `wall − (mono − at)`, as on
 * /system. Empty for anyone the gate refuses.
 */
export function stallLines(
  session: Session,
  rows: readonly RouteStall[] = stallHour(loopWatch.tally(performance.now())),
  worst: WorstNow = worstNow(),
): string[] {
  if (!mayRead(session)) return [];
  const col = (s: string) => pad(s, 10, "right");
  const lines = [
    `${pad("Route (last hour)", 40)}${col("Stall ms")}${col("Stalls")}`,
    ...rows.map((r) => `${pad(r.route, 40)}${col(String(Math.round(r.ms)))}${col(String(r.count))}`),
  ];
  if (worst.rows.length === 0) return lines;
  const when = (at: number) => `${new Date(worst.wall - (worst.mono - at)).toISOString().slice(11, 19)} UTC`;
  return [
    ...lines,
    "",
    `${pad("Worst single stalls (what ran)", 40)}${col("ms")}  When`,
    ...worst.rows.map((r) => `${pad(r.what, 40)}${col(String(Math.round(r.ms)))}  ${when(r.at)}`),
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
      const worstHead = lines.indexOf("") + 1; // 0 when there is no worst list
      const spans = lines.map((text, i) => [{ text, style: style(i === 0 || i === worstHead ? c.fg : c.mutedFg, c.bg) }]);
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
