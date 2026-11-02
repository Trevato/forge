/**
 * Organization teams in the terminal (#7997): for each organization the
 * viewer belongs to, the teams they may see with a member count, as
 * /<org>/-/teams shows them. Enter on a team lists its members, `@username`
 * and display name; esc goes back. Which teams show is `listTeamsVisibleTo`'s
 * rule, the page's: an org admin sees every team, a member only their own.
 * An admin of the organization (`orgAccess` allowing `admin`, the page's
 * `requireOrgAdmin`) adds a person with `a` and removes the member under the
 * cursor with `d` after a y/n (#8125), through the same actions
 * `POST /:owner/-/teams/:team/add` and `/remove` call, in the page's words.
 * The lines are read when the screen opens and again after a write, never on
 * every frame.
 */

import { addTeamMember, removeTeamMember } from "../../actions/orgs.ts";
import { addRefusal, addedSays, removeRefusal, removedSays } from "../../actions/team_words.ts";
import { listOrgsForUser, listTeamMembers, listTeamsVisibleTo, orgAccess, type Team } from "../../core/orgs.ts";
import type { User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, promptScreen, type ListRow } from "./common.ts";
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

/** `changed` runs after a write, so the teams list can recount. */
function teamMembersScreen(ctx: Ctx, f: Session, org: User, team: Team, changed: () => void): Screen {
  const state = new ListState();
  const admin = orgAccess(f.app.db, org.id, f.user) === "admin";
  const read = () => listTeamMembers(f.app.db, team.id).sort((a, b) => a.username.localeCompare(b.username));
  let members = read();
  const rowsOf = (): ListRow[] =>
    members.map((u) => ({ title: `@${u.username}`, ...(u.displayName === "" ? {} : { secondary: u.displayName }) }));
  let rows = rowsOf();
  const reload = () => {
    members = read();
    rows = rowsOf();
    state.clamp(members.length);
    changed();
    ctx.invalidate();
  };
  const screen: Screen = {
    title: `${org.username} / ${team.name}`,
    keys: admin
      ? [binding(["j", "k"], "move cursor"), binding(["a"], "add"), binding(["d"], "remove")]
      : [binding(["j", "k"], "move cursor")],
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (!admin || e.ctrl || e.alt) return false;
      if (e.key === "a") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Add to ${team.name}`,
            label: "Username",
            placeholder: "username",
            onSubmit: (value) => {
              const username = value.replace(/^@/, "");
              const added = addTeamMember(f.app, f.user, org, team, username);
              if (!added.ok) return addRefusal(added.error, username);
              ctx.toast(addedSays(added.value.added, username, team.name));
              reload();
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "d") {
        const member = members[state.index];
        if (member === undefined) return false;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Remove member",
            body: [`remove @${member.username} from ${team.name}? y/n`],
            actions: [{ label: "Remove", variant: "danger" }, { label: "Cancel", variant: "ghost" }],
            selected: 1,
            yesNo: true,
            onChoose: (i) => {
              if (i !== 0) return;
              const removed = removeTeamMember(f.app, f.user, org, team, member.username);
              if (!removed.ok)
                ctx.toast(removeRefusal(removed.error, member.username, org.username, team.name), "danger");
              else ctx.toast(removedSays(removed.value.removed, member.username, team.name));
              reload();
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

export function orgTeamsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let lines = orgTeamLines(f);
  const rowsOf = () =>
    lines.map(
      (l): ListRow => ({
        title: l.team.name,
        secondary: `@${l.org.username}`,
        meta: `${l.members} ${l.members === 1 ? "member" : "members"} · ${l.team.permission}`,
      }),
    );
  let rows = rowsOf();
  const recount = () => {
    lines = orgTeamLines(f);
    rows = rowsOf();
  };
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
      ctx.push(teamMembersScreen(ctx, f, line.org, line.team, recount));
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
