/**
 * /flow's waiting section in the terminal (#11455): the web page's three
 * lists, read by the same `readWaiting`, gated the same way: a forge admin who
 * is a person; anyone else is offered nothing and, were the screen reached,
 * sees no rows. A section with nothing to say draws nothing. Read-only.
 */

import { readWaiting, type Waiting } from "../../web/pages/flow-waiting.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";
const hours = (h: number): string => (h >= 48 ? `${String(Math.floor(h / 24))} d` : `${String(h)} h`);
const plural = (n: number, one: string): string => `${String(n)} ${n === 1 ? one : `${one}s`}`;

/** The sections as text lines, headings first; empty for anyone the gate refuses or when all three are quiet. */
export function waitingLines(session: Session, w: Waiting): string[] {
  if (!mayRead(session)) return [];
  const out: string[] = [];
  const section = (title: string, rows: string[]) => {
    if (rows.length === 0) return;
    if (out.length > 0) out.push("");
    out.push(title, ...rows);
  };
  section(
    "Approved, waiting on the merge queue",
    w.approved.map((a) => `  ${a.repo}: ${plural(a.waiting, "approved pull")} waiting; the oldest, #${String(a.oldest)}, for ${hours(a.oldestHours)}`),
  );
  section(
    "Stale crew pulls",
    w.stale.flatMap((s) => [
      `  ${s.repo} #${String(s.number)}: ${plural(s.days, "day")} without a push; a person closes it`,
      s.note === null ? "    No issue to fold back into." : `    Fold back into #${String(s.issueNumber)}: ${s.note}`,
    ]),
  );
  section(
    "Work a crew fork never proposed",
    w.unproposed.branches.map((b) => `  ${b.repo}: ${b.branch}, ${hours(Math.floor(b.ageMs / 3_600_000))} old, no pull`),
  );
  return out;
}

export function waitingScreen(session: Session, ctx: Ctx, w: Waiting): Screen {
  const scroll = new Scroll();
  const lines = waitingLines(session, w);
  const all = lines.length === 0 ? ["Nothing waiting."] : lines;
  return {
    title: "Pulls to land",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const spans = all.map((text) => [{ text, style: style(text.startsWith(" ") || text === "Nothing waiting." ? c.mutedFg : c.fg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, all.length);
    },
    key(e) {
      if (scroll.key(e, all.length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "pulls-to-land",
  title: "Pulls to land",
  hint: "approved pulls, stale crew pulls, unproposed work",
  after: ["flow", "boards"],
  offered: mayRead,
  run: (session, ctx) => {
    void readWaiting(session.app.db, session.app.reposRoot, new Date()).then((w) => ctx.push(waitingScreen(session, ctx, w)));
  },
};
