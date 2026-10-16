/**
 * `/system` in the terminal (#2151): the forge's RSS beside its JS heap, an
 * hour a row for the last 24 h, read through `memoryHours` like the page. The
 * gate is the page's (`canSeeMemory`): anyone but a forge admin who is a
 * person gets no rows, and the palette offers the door only to that person.
 * Read-only.
 */

import { canSeeMemory, memoryHours } from "../../boards/memory.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad } from "../term/width.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";

const mib = (n: number) => `${(n / 1_048_576).toFixed(1)}`;

/** The header, then an hour a row (UTC); empty for anyone the gate refuses. */
export function memoryLines(session: Session, now = Date.now()): string[] {
  if (!canSeeMemory(session.user)) return [];
  const hours = memoryHours(session.db, now);
  if (hours.length === 0) return ["No samples yet; the forge samples its memory every minute."];
  const col = (s: string) => pad(s, 10, "right");
  return [
    `${pad("Hour (UTC)", 17)}${col("RSS mean")}${col("RSS max")}${col("Heap mean")}${col("Heap max")}  MiB`,
    ...hours.map(
      (h) =>
        `${pad(new Date(h.at).toISOString().slice(0, 16).replace("T", " "), 17)}${col(mib(h.rssMean))}${col(mib(h.rssMax))}${col(mib(h.heapMean))}${col(mib(h.heapMax))}`,
    ),
  ];
}

export function systemScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "System memory",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = memoryLines(session);
      const spans = lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, memoryLines(session).length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}
