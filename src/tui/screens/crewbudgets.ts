/**
 * The crew's spend limits in the terminal (#11515), the second door of
 * `POST /settings/crew/budgets`: per run, per day and per month, with what
 * was spent against the day and the month. j/k choose a limit, enter types
 * its dollars; saved through the same `saveCrewBudgets` the page uses, so a
 * raised limit wakes the parked work here too. A forge admin who is a
 * person, on a forge that is its owner's own; anyone else sees nothing.
 */

import { saveCrewBudgets } from "../../actions/crew_budgets.ts";
import { BUDGET_KEYS, BUDGET_LABEL, BUDGET_MAX_USD, budgetLines, isOwnForge } from "../../crew/forge_budget.ts";
import { wokeWords } from "../../crew/wake.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { drawLines, promptScreen, Scroll } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayAct = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind === "user" && isOwnForge(f.app);

const usd = (n: number): string => `$${n.toFixed(2)}`;
const AMOUNT = new RegExp(`^\\d{1,${String(BUDGET_MAX_USD).length}}(\\.\\d{1,2})?$`);
const BAD_AMOUNT = `Dollars and cents, from $0.01 to $${BUDGET_MAX_USD.toLocaleString("en-US")}.`;

/** One limit a line, the chosen one marked, with what is spent against it; empty for anyone the gate refuses. */
export function budgetRows(f: Session, chosen: number): string[] {
  if (!mayAct(f)) return [];
  return budgetLines(f.app.db, new Date()).map((l, i) => {
    const spent = l.spentUsd === undefined ? "" : ` (${usd(l.spentUsd)} spent this ${l.key === "day" ? "day" : "month"}, UTC)`;
    return `${i === chosen ? ">" : " "} Spend ${BUDGET_LABEL[l.key]}: ${usd(l.limitUsd)}${spent}`;
  });
}

/** Set the chosen limit from what was typed: what it says, and whether it was saved. Nothing is saved for anyone the gate refuses. */
export function setChosen(f: Session, chosen: number, raw: string): { said: string; saved: boolean } {
  const key = BUDGET_KEYS[chosen];
  if (!mayAct(f) || key === undefined) return { said: "Only a forge admin sets a budget.", saved: false };
  const text = raw.trim();
  if (!AMOUNT.test(text)) return { said: BAD_AMOUNT, saved: false };
  const saved = saveCrewBudgets(f.app, f.user, { [key]: Number(text) });
  if (!saved.ok) return { said: BAD_AMOUNT, saved: false };
  return { said: `Spend ${BUDGET_LABEL[key]} is ${usd(Number(text))}. ${wokeWords(saved.woken)}`.trim(), saved: true };
}

export function crewBudgetsScreen(f: Session, ctx: Ctx): Screen {
  let chosen = 0;
  let note = "";
  const screen: Screen = {
    title: "Crew budgets",
    keys: [binding(["j", "k"], "choose"), binding(["enter"], "set"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = [...budgetRows(f, chosen), ...(note === "" ? [] : ["", note])];
      drawLines(s, area, c, new Scroll(), lines.map((text) => [{ text, style: style(c.fg, c.bg) }]));
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "j" || e.key === "down") chosen = Math.min(chosen + 1, BUDGET_KEYS.length - 1);
      else if (e.key === "k" || e.key === "up") chosen = Math.max(chosen - 1, 0);
      else if (e.key === "enter" && mayAct(f))
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Spend ${BUDGET_LABEL[BUDGET_KEYS[chosen]!]} (dollars)`,
            label: "Dollars and cents",
            onSubmit: (value) => {
              const r = setChosen(f, chosen, value);
              if (!r.saved) return r.said;
              note = r.said;
              ctx.invalidate();
              return undefined;
            },
          }),
        );
      else return false;
      ctx.invalidate();
      return true;
    },
  };
  return screen;
}

/** The crew's spend limits: per run, per day, per month. */
export const entry: PaletteEntry = {
  id: "crewbudgets",
  title: "Crew budgets",
  hint: "what the crew may spend per run, day and month on your key",
  after: ["crewkey", "subscriptions"],
  offered: mayAct,
  run: (session, ctx) => ctx.push(crewBudgetsScreen(session, ctx)),
};
