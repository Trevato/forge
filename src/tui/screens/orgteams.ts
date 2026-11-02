/**
 * Organization teams in the terminal (#7997): for each organization the
 * viewer belongs to, the teams they may see with a member count, as
 * /<org>/-/teams shows them. Enter on a team lists its members, `@username`
 * and display name; esc goes back. Which teams show is `listTeamsVisibleTo`'s
 * rule, the page's: an org admin sees every team, a member only their own.
 * Read-only: no key here adds or removes anyone, so the lines are read once
 * when the screen opens, not on every frame.
 */

import { listOrgsForUser, listTeamMembers, listTeamsVisibleTo, type Team } from "../../core/orgs.ts";
import type { User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** One line of the list: a team of an organization, with its member count. */
type Line = { readonly org: User; readonly team: Team; readonly members: number };

/**
 * Per organization the viewer is in, the teams they may see, in name order.
 * `listOrgsForUser` only names orgs where the viewer is on a team, so every
 * org here has at least that team to show.
 */
export function orgTeamLines(f: Session): Line[] {
  const user = f.user;
  if (user === undefined) return [];
  const lines: Line[] = [];
  const orgs = listOrgsForUser(f.app.db, user.id).sort((a, b) => a.username.localeCompare(b.username));
  for (const org of orgs) {
    for (const team of listTeamsVisibleTo(f.app.db, org.id, user))
      lines.push({ org, team, members: listTeamMembers(f.app.db, team.id).length });
  }
  return lines;
}

function teamMembersScreen(ctx: Ctx, f: Session, org: User, team: Team): Screen {
  const state = new ListState();
  const rows: ListRow[] = listTeamMembers(f.app.db, team.id)
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((u) => ({ title: `@${u.username}`, ...(u.displayName === "" ? {} : { secondary: u.displayName }) }));
  return {
    title: `${org.username} / ${team.name}`,
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      return state.key(e, rows.length);
    },
  };
}

export function orgTeamsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const lines = orgTeamLines(f);
  const rows = lines.map(
    (l): ListRow => ({
      title: l.team.name,
      secondary: `@${l.org.username}`,
      meta: `${l.members} ${l.members === 1 ? "member" : "members"} · ${l.team.permission}`,
    }),
  );
  return {
    title: "Organization teams",
    keys: [binding(["j", "k"], "move cursor"), binding(["enter"], "members")],
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (state.key(e, lines.length)) return true;
      if (e.ctrl || e.alt || e.key !== "enter") return false;
      const line = lines[state.index];
      if (line === undefined) return false;
      ctx.push(teamMembersScreen(ctx, f, line.org, line.team));
      return true;
    },
  };
}

/** Organization teams, as /<org>/-/teams has them: anyone signed in who belongs to an organization. */
export const entry: PaletteEntry = {
  id: "org-teams",
  title: "Organization teams",
  hint: "who is in each team of your organizations",
  after: ["teams", "limits", "quotas", "people"],
  offered: (session) =>
    session.user !== undefined && listOrgsForUser(session.app.db, session.user.id).length > 0,
  run: (session, ctx) => ctx.push(orgTeamsScreen(session, ctx)),
};
