/**
 * The crew's scorecard in the terminal, a forge admin's (#2677): each
 * agent's pulls landed of opened, review rounds and red checks over the
 * last `RECENT_DAYS` days beside all time, then reverts and time to land
 * over all time, as Settings → Crew shows them (`crewScorecards`). The gate
 * is the page's: a forge admin; anyone else sees nothing.
 */

import { listAllAgents } from "../../actions/crew.ts";
import {
  crewScorecards,
  RECENT_DAYS,
  recentWindow,
  spanText,
  type Scorecard,
} from "../../core/scorecard.ts";
import type { Agent } from "../../core/agents.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

const landed = (s: Scorecard | undefined) =>
  s === undefined ? "—" : `${s.landed} of ${s.opened}`;
const rounds = (s: Scorecard | undefined) =>
  s?.reviewRounds == null ? "—" : s.reviewRounds.toFixed(1);
const red = (s: Scorecard | undefined) =>
  s?.redCheckRate == null ? "—" : `${Math.round(100 * s.redCheckRate)}%`;

/**
 * One row per agent; one with no pull yet says so rather than a row of
 * zeros. Each windowed figure reads "<recent>d … · all …", the page's order.
 */
export function scorecardRows(
  agents: readonly Agent[],
  cards: ReadonlyMap<string, Scorecard>,
  recent: ReadonlyMap<string, Scorecard>,
): ListRow[] {
  const d = `${RECENT_DAYS}d`;
  return agents.map((agent) => {
    const s = cards.get(agent.user.id);
    if (s === undefined)
      return { title: agent.user.username, secondary: "no pull yet" };
    const r = recent.get(agent.user.id);
    return {
      title: agent.user.username,
      secondary: `landed ${d} ${landed(r)} · all ${landed(s)}`,
      meta: [
        `review rounds ${d} ${rounds(r)} · all ${rounds(s)}`,
        `red checks ${d} ${red(r)} · all ${red(s)}`,
        `reverts ${s.reverts}`,
        `time to land ${s.meanLandMs === null ? "—" : spanText(s.meanLandMs)}`,
      ].join("  "),
    };
  });
}

export function scorecardScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = f.user?.isAdmin === true;
  // Read once when the screen opens, as the page reads it once per request.
  const listed = allowed ? listAllAgents(f.app, f.user) : undefined;
  const rows =
    listed?.ok === true
      ? scorecardRows(
          listed.value,
          crewScorecards(f.db),
          crewScorecards(f.db, recentWindow()),
        )
      : [];
  return {
    title: "Crew scorecard per agent",
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text = !allowed
        ? "The crew's scorecard is read by a forge admin."
        : rows.length === 0
          ? "No agents yet."
          : `Over the last ${RECENT_DAYS} days (${RECENT_DAYS}d) and all time, ` +
            "as Settings → Crew shows it.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows);
    },
    key: (e) => state.key(e, rows.length),
  };
}
