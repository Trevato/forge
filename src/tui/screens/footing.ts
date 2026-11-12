/**
 * What the forge stands on, in the terminal (#11685): the rows /system shows
 * under the same heading. First where the forge runs (or why that was not
 * read), then each piece on another machine, in the order switching pg-grand
 * off would break the forge: its step, what it is needed for, the piece, the
 * machine it was found on, and what happens if that machine dies. Last, the
 * pieces on the forge's own machine, by name. The last reading
 * (`footing.peek`), so the screen never waits on the cluster; the declared
 * list while the first read runs. The gate is /system's: a forge admin who is
 * a person. Read-only.
 */

import { BREAK_STEPS, declaredFooting, footing, offMachine, whereWords, type Footing } from "../../system/footing.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad } from "../term/width.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

const current = (): Footing => footing.peek() ?? declaredFooting("the cluster is being read; reopen in a moment");

/** The screen's lines; empty for anyone the gate refuses. */
export function footingLines(session: Session, f: Footing = current()): string[] {
  if (!mayRead(session)) return [];
  const off = offMachine(f);
  const home = f.rows.filter((r) => !r.risk);
  const where =
    f.forgeNode === null ? `The forge's node was not read (${f.unread ?? "unknown"}); machines are as declared.` : `The forge runs on ${f.forgeNode}.`;
  const lines = [where, ""];
  if (off.length === 0) lines.push("Every piece runs on the forge's own machine.");
  else {
    lines.push(`${String(off.length)} of ${String(f.rows.length)} pieces run on another machine. With pg-grand off, they fail in this order:`);
    for (const r of off) {
      const step = r.breaks === undefined ? "-" : String(r.breaks);
      lines.push("", `${pad(step, 3, "right")}  ${pad(r.need, 8)}  ${r.what}`);
      lines.push(`${pad("", 15)}on ${whereWords(r)}`, `${pad("", 15)}if it dies: ${r.ifDies}`);
    }
    lines.push("", "The steps:", ...BREAK_STEPS.map((s, i) => `${pad(String(i + 1), 3, "right")}  ${s}`));
  }
  if (home.length > 0) lines.push("", `On the forge's own machine: ${home.map((r) => r.id).join(", ")}`);
  return lines;
}

export function footingScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "What the forge stands on",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = footingLines(session);
      drawLines(s, area, c, scroll, lines.map((text) => [{ text, style: style(/^\s*\d+ {2}/.test(text) || text === "" ? c.fg : c.mutedFg, c.bg) }]));
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, footingLines(session).length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "footing",
  title: "What the forge stands on",
  hint: "each piece on another machine, in the order it would break the forge",
  after: ["stalls", "system"],
  offered: mayRead,
  run: (session, ctx) => ctx.push(footingScreen(session, ctx)),
};
