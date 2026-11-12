/**
 * Organization teams in the terminal (#7997): for each organization the
 * viewer belongs to, the teams they may see with a member count, as
 * /<org>/-/teams shows them. Enter on a team lists its members, `@username`
 * and display name; esc goes back. Which teams show is `listTeamsVisibleTo`'s
 * rule, the page's: an org admin sees every team, a member only their own.
 * An admin of the organization (`orgAccess` allowing `admin`, the page's
 * `requireOrgAdmin`) adds a person with `a` and removes the member under the
 * cursor with `d` after a y/n (#8125), and sets the role of the member
 * under the cursor with `r` (#571: planner, builder, reviewer or member, the
 * seat a write team gives an agent on the org's crew), and opens its figures,
 * how fast it ships, with `m` (#572, `teamfigures.ts`), through the same actions
 * `POST /:owner/-/teams/:team/add` and `/remove` call, in the page's words.
 * On the list, an admin of the selected team's organization makes a team with
 * `n` (a name, then read, write or admin) and deletes the selected team with
 * `D` once its name is typed in full (#8126), through `createTeam` and
 * `deleteTeam` as `POST /:owner/-/teams` and `/:team/delete` do.
 * The lines are read when the screen opens and again after a write, never on
 * every frame.
 */

import { addTeamMember, createTeam, deleteTeam, removeTeamMember } from "../../actions/orgs.ts";
import {
  addRefusal,
  addedSays,
  createRefusal,
  createdSays,
  deleteRefusal,
  deletedSays,
  removeRefusal,
  removedSays,
} from "../../actions/team_words.ts";
import { TEAM_ROLES, isTeamRole } from "../../core/agents.ts";
import {
  listOrgsForUser,
  listTeamMemberRoles,
  listTeamMembers,
  listTeamsVisibleTo,
  orgAccess,
  type Permission,
  type Team,
} from "../../core/orgs.ts";
import type { User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, confirmScreen, drawList, later, pickerScreen, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { teamFiguresScreen } from "./teamfigures.ts";

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
  const read = () =>
    listTeamMemberRoles(f.app.db, team.id).map(({ user, role }) => ({ ...user, role }));
  let members = read();
  const rowsOf = (): ListRow[] =>
    members.map((u) => ({
      title: `@${u.username}`,
      ...(u.displayName === "" ? {} : { secondary: u.displayName }),
      meta: u.role,
    }));
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
      ? [binding(["j", "k"], "move cursor"), binding(["a"], "add"), binding(["r"], "role"), binding(["d"], "remove"), binding(["m"], "figures")]
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
      if (e.key === "m") {
        ctx.push(teamFiguresScreen(ctx, f, org, team));
        return true;
      }
      if (e.key === "r") {
        const member = members[state.index];
        if (member === undefined) return false;
        ctx.push(
          pickerScreen(ctx, screen, {
            title: `@${member.username}: role`,
            items: TEAM_ROLES.map((role) => ({ id: role, label: role })),
            onPick: ([chosen]) => {
              if (!isTeamRole(chosen)) return;
              const set = addTeamMember(f.app, f.user, org, team, member.username, chosen);
              if (!set.ok) ctx.toast(addRefusal(set.error, member.username), "danger");
              else ctx.toast(`@${member.username} is ${set.value.role} on ${team.name}.`);
              reload();
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

/** The permissions a team may grant, read first: the one `teamCreate` falls back to. */
const PERMISSIONS: readonly Permission[] = ["read", "write", "admin"];

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
    state.clamp(lines.length);
  };
  /** The line under the cursor when the viewer administers its organization, the page's `requireOrgAdmin`. */
  const adminLine = (): Line | undefined => {
    const line = lines[state.index];
    return line !== undefined && orgAccess(f.app.db, line.org.id, f.user) === "admin" ? line : undefined;
  };
  /** `n`: a name, then the permission (read first, as `teamCreate` falls back to it), then `createTeam`. */
  const make = (org: User): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: `New team in ${org.username}`,
        label: "Team name",
        placeholder: "name",
        onSubmit: (name) => {
          if (name === "") return createRefusal("invalid_name", org.username, name);
          return later(ctx, () =>
            pickerScreen(ctx, screen, {
              title: `${name}: permission`,
              items: PERMISSIONS.map((p) => ({ id: p, label: p })),
              onPick: ([chosen]) => {
                const permission: Permission = chosen === "write" || chosen === "admin" ? chosen : "read";
                const created = createTeam(f.app, f.user, org, name, permission);
                if (!created.ok) ctx.toast(createRefusal(created.error, org.username, name), "danger");
                else ctx.toast(createdSays(created.value.name, permission));
                recount();
                ctx.invalidate();
              },
            }),
          );
        },
      }),
    );
  };
  /** `D`: the team's name typed in full, then `deleteTeam`; any other text deletes nothing. */
  const remove = (line: Line): void => {
    const { org, team } = line;
    ctx.push(
      promptScreen(ctx, screen, {
        title: `Delete ${team.name}`,
        label: `Type ${team.name} to confirm`,
        hint: "Everyone on it loses the access it gave.",
        placeholder: team.name,
        onSubmit: (typed) => {
          if (typed !== team.name) return `Type ${team.name} to confirm.`;
          const deleted = deleteTeam(f.app, f.user, org, team);
          if (!deleted.ok) ctx.toast(deleteRefusal(deleted.error, team.name), "danger");
          else ctx.toast(deletedSays(team.name));
          recount();
          ctx.invalidate();
          return undefined;
        },
      }),
    );
  };
  const screen: Screen = {
    title: "Organization teams",
    get keys() {
      return adminLine() === undefined
        ? [binding(["j", "k"], "move cursor"), binding(["enter"], "members")]
        : [
            binding(["j", "k"], "move cursor"),
            binding(["enter"], "members"),
            binding(["n"], "new team"),
            binding(["D"], "delete team"),
          ];
    },
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (state.key(e, lines.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "n" || e.key === "D") {
        const line = adminLine();
        if (line === undefined) return false;
        if (e.key === "n") make(line.org);
        else remove(line);
        return true;
      }
      if (e.key !== "enter") return false;
      const line = lines[state.index];
      if (line === undefined) return false;
      ctx.push(teamMembersScreen(ctx, f, line.org, line.team, recount));
      return true;
    },
  };
  return screen;
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
