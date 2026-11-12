/**
 * From visit to paid, in the terminal (#11259): the last 7 days of Settings →
 * Billing's block (`perf/funnel.ts`), the same figures, offered to the same
 * people: a forge admin who is a person. Anyone else is offered nothing and,
 * were the screen reached, sees no rows. `w` flips 7 and 30 days. Read-only.
 */

import { funnelReport, type FunnelReport } from "../../perf/funnel.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const mayRead = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";

/** One row per step with its share of the step before, then clicks by plan, then referrers. */
export function funnelRows(r: FunnelReport): ListRow[] {
  const rows: ListRow[] = r.steps.map((s) => ({ title: s.label, meta: s.pct === null ? `${s.count}` : `${s.count} · ${s.pct}% of the step before` }));
  for (const c of r.clicks_by_plan) rows.push({ title: `Clicked ${c.plan}`, meta: `${c.count}` });
  for (const x of r.referrers) rows.push({ title: `Plan clicks from ${x.source}`, meta: `${x.count}` });
  return rows;
}

export function funnelScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let days = 7;
  const screen: Screen = {
    title: "From visit to paid",
    keys: [binding(["j", "k"], "move cursor"), binding(["w"], "7 or 30 days"), binding(["esc"], "back")],
    render(area, s) {
      const rows = mayRead(f) ? funnelRows(funnelReport(f.db, days)) : [];
      state.clamp(rows.length);
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (!mayRead(f)) return false;
      if (e.key === "w") {
        days = days === 7 ? 30 : 7;
        return true;
      }
      return state.key(e, funnelRows(funnelReport(f.db, days)).length);
    },
  };
  return screen;
}

export const entry: PaletteEntry = {
  id: "from-visit-to-paid",
  title: "From visit to paid",
  hint: "the last 7 days: home visits, plans seen, plan clicks, forges made, paid",
  offered: mayRead,
  run: (f, ctx) => ctx.push(funnelScreen(f, ctx)),
};
