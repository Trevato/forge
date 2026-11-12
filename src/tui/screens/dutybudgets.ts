/**
 * Maintenance duty budgets in the terminal (#11206): the budgets block of /maintenance, through
 * the same `setBudget`, behind the same gate (a forge admin who is a person), for reads and
 * writes alike. j/k choose a duty; +/- move its runs per day by one, ]/[ its dollars per day by
 * one; 0 takes both back to the duty's own. Esc or q closes.
 */

import { budgetOf, DOLLARS_MAX, DOLLARS_MIN, RUNS_MAX, setBudget, usedToday, type BudgetKind } from "../../maintain/budget.ts";
import { duties } from "../../maintain/registry.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { drawLines, Scroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayAct = (session: Session): boolean => session.user?.isAdmin === true && session.user.kind !== "agent";

/** One duty a line, the chosen one marked; empty for anyone the gate refuses. */
export function budgetLines(session: Session, chosen: number): string[] {
  if (!mayAct(session)) return [];
  return duties.map((d, i) => {
    const b = budgetOf(session.db, d);
    const u = usedToday(session.db, d.name, new Date());
    return `${i === chosen ? ">" : " "} ${d.name}: ${u.runs} of ${b.runsPerDay} runs, $${u.dollars.toFixed(2)} of $${b.dollarsPerDay.toFixed(2)} today (${d.budget.reason})`;
  });
}

/** Move the chosen duty's budget by `delta` (or back to its own with `reset`); what it says, or nothing for anyone the gate refuses. */
export function moveBudget(session: Session, chosen: number, kind: BudgetKind, delta: number, reset = false): string {
  if (!mayAct(session)) return "";
  const d = duties[chosen];
  if (d === undefined) return "";
  const actor = session.user!.id;
  if (reset) {
    setBudget(session.db, d, "runs", null, actor);
    setBudget(session.db, d, "dollars", null, actor);
    return `${d.name} is back to its own budget.`;
  }
  const b = budgetOf(session.db, d);
  const [now, lo, hi] = kind === "runs" ? [b.runsPerDay, 1, RUNS_MAX] : [b.dollarsPerDay, DOLLARS_MIN, DOLLARS_MAX];
  const next = Math.min(hi, Math.max(lo, now + delta));
  setBudget(session.db, d, kind, next, actor);
  return `${d.name}: ${kind === "runs" ? "runs" : "dollars"} per day is ${next}.`;
}

export function dutyBudgetScreen(session: Session, ctx: Ctx): Screen {
  let chosen = 0;
  let note = "";
  return {
    title: "Maintenance duty budgets",
    keys: [binding(["j", "k"], "choose"), binding(["+", "-"], "runs"), binding(["]", "["], "dollars"), binding(["0"], "reset"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = [...budgetLines(session, chosen), ...(note === "" ? [] : ["", note])];
      drawLines(s, area, c, new Scroll(), lines.map((text) => [{ text, style: style(c.fg, c.bg) }]));
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") chosen = Math.min(chosen + 1, duties.length - 1);
      else if (e.key === "k" || e.key === "up") chosen = Math.max(chosen - 1, 0);
      else if (e.key === "+") note = moveBudget(session, chosen, "runs", 1);
      else if (e.key === "-") note = moveBudget(session, chosen, "runs", -1);
      else if (e.key === "]") note = moveBudget(session, chosen, "dollars", 1);
      else if (e.key === "[") note = moveBudget(session, chosen, "dollars", -1);
      else if (e.key === "0") note = moveBudget(session, chosen, "runs", 0, true);
      else return false;
      ctx.invalidate();
      return true;
    },
  };
}

export const entry: PaletteEntry = {
  id: "maintenance-budgets",
  title: "Set a maintenance duty's budget",
  hint: "runs per day and dollars per day a duty may use",
  after: ["maintenance-duties", "maintenance-runs"],
  offered: mayAct,
  run: (session, ctx) => ctx.push(dutyBudgetScreen(session, ctx)),
};
