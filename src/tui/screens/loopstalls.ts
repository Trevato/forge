/**
 * Main-thread stalls in the terminal, the owner's (#9016): the last hour's
 * top routes by milliseconds the loop was held past 200 ms, with
 * /api/v1/telemetry/flow always listed — the rows `/system` and `/metrics`
 * read (`stallHour`); then, as /system draws them (#11069), the last hour's
 * worst single stalls — what ran, its ms, and when, in UTC — only when there
 * is one. Above them, as /system draws it (#11220), the last 20 minutes'
 * worst loop lag against the 100 ms bar: how many are over, then each minute,
 * its ms, "over" when past the bar, and what its worst named stall ran under.
 * The gate is `/system`'s: a forge admin who is a person. Read-only.
 */

import { stallHour } from "../../metrics/stalls.ts";
import { HOUR_MS, type RouteStall } from "../../perf/loop.ts";
import { lagMinutes, loopWatch, stallBlame } from "../../perf/live.ts";
import { LAG_BAR_MS, LAG_READINGS, overBar, type LagReading } from "../../perf/lag_minutes.ts";
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

/**
 * The loop-lag readings as /system's "Loop lag" section reads them: a header
 * with the count over the 100 ms bar, then a minute a row, oldest first, its
 * start in UTC, its worst ms, `over` when strictly past the bar, and what ran
 * (or "not named"). Empty for anyone the gate refuses.
 */
export function lagLines(session: Session, rows: readonly LagReading[] = lagMinutes.readings()): string[] {
  if (!mayRead(session)) return [];
  const head = `Loop lag, last ${String(LAG_READINGS)} minutes`;
  if (rows.length === 0) return [head, "No full minute measured yet."];
  const over = overBar(rows);
  const tally = over === 0 ? `all ${String(rows.length)} under ${String(LAG_BAR_MS)} ms` : `${String(over)} of ${String(rows.length)} over ${String(LAG_BAR_MS)} ms`;
  return [
    `${head}: ${tally}`,
    `${pad("Minute (UTC)", 14)}${pad("Worst ms", 10, "right")}${pad("", 6)}What ran`,
    ...rows.map((r) => {
      const isOver = r.ms > LAG_BAR_MS;
      return `${pad(`${new Date(r.at).toISOString().slice(11, 16)}`, 14)}${pad(String(Math.round(r.ms)), 10, "right")}${pad(isOver ? "  over" : "", 6)}${r.what ?? "not named"}`;
    }),
  ];
}

/** Everything the screen draws: the loop lag, a blank line, then the stalls; with the header rows' indexes. */
function screenLines(session: Session): { lines: string[]; heads: Set<number> } {
  const lag = lagLines(session);
  const stalls = stallLines(session);
  const lines = lag.length === 0 ? stalls : [...lag, "", ...stalls];
  const base = lag.length === 0 ? 0 : lag.length + 1;
  const heads = new Set<number>();
  if (lag.length > 0) heads.add(0);
  if (stalls.length > 0) heads.add(base);
  const worstGap = stalls.indexOf("");
  if (worstGap >= 0) heads.add(base + worstGap + 1);
  return { lines, heads };
}

export function stallsScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "Main-thread stalls",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const { lines, heads } = screenLines(session);
      const spans = lines.map((text, i) => [{ text, style: style(heads.has(i) ? c.fg : c.mutedFg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, screenLines(session).lines.length)) return true;
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
