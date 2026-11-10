/**
 * The crew's week in the terminal (#10722): one line per member, merged,
 * returned and spend over the last 7 days, as Settings → Crew's "This week"
 * block has it (`weekCard`). Gated as the page, the API and MCP are: a forge
 * admin; anyone else sees one sentence and no figures.
 */

import { weekCard, WEEK_DAYS, type WeekLine } from "../../crew/week_card.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** One row per member; one with nothing in the week reads "idle", not zeros. */
export function weekRows(lines: readonly WeekLine[]): ListRow[] {
  return lines.map((l) => ({
    title: l.username,
    secondary: l.idle ? "idle" : `merged ${l.merged} · returned ${l.returned} · spent $${l.spentUsd.toFixed(2)}`,
  }));
}

export function weekCardScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = f.user?.isAdmin === true;
  const rows = allowed ? weekRows(weekCard(f.db)) : [];
  return {
    title: "Crew this week",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = !allowed
        ? "The crew's week is read by a forge admin."
        : rows.length === 0
          ? "No agents yet."
          : `The last ${WEEK_DAYS} days.`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows);
    },
    key: (e) => state.key(e, rows.length),
  };
}

/** Settings → Crew's "This week" block: a forge admin. */
export const entry: PaletteEntry = {
  id: "crew-week",
  title: "Crew this week",
  hint: "each agent's pulls merged, returned and spend over 7 days",
  after: ["scorecard"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(weekCardScreen(session, ctx)),
};
