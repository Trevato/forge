/**
 * Pause and resume a maintenance duty in the terminal (#11205): the switches
 * of the /maintenance page, through the same `switchDuty`, behind the same
 * gate (a forge admin who is a person). j/k choose a duty, Enter or Space
 * flips it, Esc or q closes. The write is to the forge's own database, so a
 * web viewer sees it on its next load.
 */

import { dutyStates, switchDuty } from "../../maintain/pause.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { drawLines, Scroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayAct = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

/** One duty a line, the chosen one marked; empty for anyone the gate refuses. */
export function dutyLines(session: Session, chosen: number): string[] {
  if (!mayAct(session)) return [];
  return dutyStates(session.db).map((d, i) => `${i === chosen ? ">" : " "} ${d.says}`);
}

/** Flip the chosen duty; what it says, or nothing for anyone the gate refuses. */
export function flipDuty(session: Session, chosen: number): string {
  if (!mayAct(session)) return "";
  const d = dutyStates(session.db)[chosen];
  if (d === undefined) return "";
  const r = switchDuty(session.db, d.name, !d.paused, session.user!.username);
  return r.says;
}

export function dutySwitchScreen(session: Session, ctx: Ctx): Screen {
  let chosen = 0;
  let note = "";
  const count = (): number => dutyStates(session.db).length;
  return {
    title: "Maintenance duties",
    keys: [binding(["j", "k"], "choose"), binding(["enter", "space"], "pause or resume"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = [...dutyLines(session, chosen), ...(note === "" ? [] : ["", note])];
      drawLines(s, area, c, new Scroll(), lines.map((text) => [{ text, style: style(c.fg, c.bg) }]));
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") chosen = Math.min(chosen + 1, count() - 1);
      else if (e.key === "k" || e.key === "up") chosen = Math.max(chosen - 1, 0);
      else if (e.key === "enter" || e.key === " " || e.key === "space") note = flipDuty(session, chosen);
      else return false;
      ctx.invalidate();
      return true;
    },
  };
}

export const entry: PaletteEntry = {
  id: "maintenance-duties",
  title: "Pause or resume a maintenance duty",
  hint: "switch a duty off, or on again after it paused itself",
  after: ["maintenance-runs", "maintenance"],
  offered: mayAct,
  run: (session, ctx) => ctx.push(dutySwitchScreen(session, ctx)),
};
