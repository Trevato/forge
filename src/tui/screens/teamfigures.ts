/**
 * A team's coordination figures in the terminal (#572): the rows the page
 * /<org>/-/teams/<team> shows, one per figure, its last 24 hours and last 7
 * days beneath. Reached with `m` on a team's members in Organization teams,
 * offered only to an admin of the organization, the page's `requireOrgAdmin`.
 * The figures are read once when the screen opens, from the minute's cache
 * the page and `org_teams` share.
 */

import { orgAccess, type Team } from "../../core/orgs.ts";
import { metricsRows, teamWindows } from "../../core/team-metrics.ts";
import type { User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, type ListRow } from "./common.ts";

/** One row per figure, the day's and the week's values beneath; none for anyone but an org admin. */
export function teamFigureRows(f: Session, org: User, team: Team, now = Date.now()): ListRow[] {
  if (orgAccess(f.app.db, org.id, f.user) !== "admin") return [];
  const { day, week } = teamWindows(f.app.db, team.id, now);
  const weekRows = metricsRows(week);
  return metricsRows(day).map((r, i) => ({
    title: r.label,
    below: [`24 h: ${r.value}`, `7 d: ${weekRows[i]!.value}`],
  }));
}

export function teamFiguresScreen(ctx: Ctx, f: Session, org: User, team: Team): Screen {
  const state = new ListState();
  const rows = teamFigureRows(f, org, team);
  return {
    title: `${org.username} / ${team.name}: how fast it ships`,
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      return state.key(e, rows.length);
    },
  };
}
