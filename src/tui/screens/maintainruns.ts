/**
 * The latest maintenance duty runs in the terminal (#11204): what
 * `GET /api/v1/maintenance/runs` lists, through the same read (`latest`) and
 * the same gate, a forge admin; anyone else is offered nothing and sees no
 * rows. Read-only; j/k scroll, Esc or q closes it.
 */

import { latest } from "../../maintain/runs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { pad } from "../term/width.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (session: Session): boolean => session.user?.isAdmin === true;

/** A header, then a run a row: duty, started, findings, probes, outcome. Empty for anyone the gate refuses. */
export function runLines(session: Session, limit = 50): string[] {
  if (!mayRead(session)) return [];
  const head = `${pad("Duty", 24)}${pad("Started (UTC)", 21)}${pad("Found", 7)}${pad("Probes", 8)}Outcome`;
  const rows = latest(session.db, limit).map(
    (r) =>
      `${pad(r.duty, 24)}${pad(r.started.slice(0, 19).replace("T", " "), 21)}${pad(String(r.findings.length), 7)}${pad(String(r.probes.length), 8)}${r.outcome}`,
  );
  return [head, ...rows];
}

export function maintainRunsScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "Maintenance duty runs",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = runLines(session);
      const spans = lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, runLines(session).length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "maintenance-runs",
  title: "Maintenance duty runs",
  hint: "what each duty found, did and probed",
  after: ["maintenance"],
  offered: mayRead,
  run: (session, ctx) => ctx.push(maintainRunsScreen(session, ctx)),
};
