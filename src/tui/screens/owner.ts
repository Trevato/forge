/**
 * A user or an organization: their repositories, and — for an org you
 * administer — its teams and who is on them.
 *
 * Team management is the admin surface, so it is hidden rather than disabled
 * for anyone else: `listTeamsVisibleTo` already returns nothing to a
 * non-member, and the keys follow that answer.
 */

import {
  addTeamMember,
  createTeam,
  removeTeamMember,
} from "../../actions/orgs.ts";
import {
  accessAllows,
  listTeamMembers,
  listTeamsVisibleTo,
  orgAccess,
  type Team,
} from "../../core/orgs.ts";
import { listReposByOwner, type Repo } from "../../core/repos.ts";
import { getUserByName, type User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState, tabs } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  drawList,
  errorText,
  promptScreen,
  runAsync,
} from "./common.ts";
import { repoScreen } from "./repo.ts";

export function ownerScreen(f: Session, ctx: Ctx, name: string): Screen {
  let owner: User | undefined;
  let repos: Repo[] = [];
  let teams: Team[] = [];
  let members: User[] = [];
  let tab = 0;
  const state = new ListState();
  const filter = new Filter();

  const isOrg = (): boolean => owner?.kind === "org";
  const isAdmin = (): boolean =>
    owner !== undefined &&
    isOrg() &&
    accessAllows(orgAccess(f.db, owner.id, f.user), "admin");

  const reload = (): void => {
    owner = getUserByName(f.db, name);
    repos = listReposByOwner(f.db, name, f.user, { limit: 200 });
    teams =
      owner && owner.kind === "org"
        ? listTeamsVisibleTo(f.db, owner.id, f.user)
        : [];
    const team = teams[Math.min(state.index, teams.length - 1)];
    members = tab === 1 && team ? listTeamMembers(f.db, team.id) : [];
    ctx.invalidate();
  };

  const shown = (): Repo[] => repos.filter((r) => filter.matches(r.name));

  const screen: Screen = {
    title: name,
    get keys() {
      if (tab === 1)
        return [
          binding(["tab"], "repos/teams"),
          binding(["j", "k"], "move"),
          binding(["n"], "new team", { disabled: !isAdmin() }),
          binding(["a"], "add member", { disabled: !isAdmin() }),
          binding(["D"], "remove member", { disabled: !isAdmin() }),
        ];
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        binding(["/"], "filter"),
        ...(isOrg() && teams.length > 0
          ? [binding(["tab"], "repos/teams")]
          : []),
      ];
    },
    load() {
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (!owner) {
        emptyState(s, area, c, {
          title: "Not found",
          body: `No user or organization named ${name}.`,
        });
        return;
      }
      const [head, body] = split(area, "v", [
        len(isOrg() && teams.length > 0 ? 2 : 1),
        fill(1),
      ]);
      if (isOrg() && teams.length > 0)
        tabs(s, head!, c, {
          items: [
            { label: "Repositories", count: repos.length },
            { label: "Teams", count: teams.length },
          ],
          active: tab,
        });
      else
        s.text(
          head!.x,
          head!.y,
          truncate(
            `${owner.displayName || owner.username} · ${owner.kind} · ${repos.length} repos`,
            head!.w,
          ),
          style(c.mutedFg, c.bg),
          head!.x + head!.w,
        );

      if (tab === 1) {
        const [left, right] = split(body!, "h", [len(28), fill(1)]);
        drawList(
          s,
          left!,
          c,
          state,
          teams.map((t) => ({ title: t.name, meta: t.permission })),
        );
        members.forEach((member, i) => {
          if (i >= right!.h) return;
          s.text(
            right!.x + 1,
            right!.y + i,
            truncate(member.username, right!.w - 1),
            style(c.fg, c.bg),
            right!.x + right!.w,
          );
        });
        if (members.length === 0)
          s.text(
            right!.x + 1,
            right!.y,
            "No members",
            style(c.faint, c.bg),
            right!.x + right!.w,
          );
        return;
      }

      const [box, list] = split(body!, "v", [len(1), fill(1)]);
      ctx.setCursor(filter.render(s, box!, c, "filter repositories"));
      const rows = shown();
      if (rows.length === 0) {
        emptyState(s, list!, c, {
          title: "No repositories",
          body: "Nothing here that you can see.",
        });
        return;
      }
      drawList(
        s,
        list!,
        c,
        state,
        rows.map((repo) => ({
          title: repo.name,
          secondary: repo.description,
          meta: repo.visibility === "private" ? "private" : "",
        })),
      );
    },
    key(e) {
      if (filter.key(e)) {
        state.clamp(shown().length);
        return true;
      }
      if (e.key === "tab" && isOrg() && teams.length > 0) {
        tab = tab === 0 ? 1 : 0;
        state.index = 0;
        reload();
        return true;
      }
      if (tab === 1) {
        if (state.key(e, teams.length)) {
          reload();
          return true;
        }
        return teamKey(e.key);
      }
      if (state.key(e, shown().length)) return true;
      if (e.key === "enter") {
        const repo = shown()[state.index];
        if (repo) ctx.push(repoScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => reload());
        return true;
      }
      return false;
    },
  };

  function teamKey(key: string): boolean {
    if (!owner || !isAdmin()) return false;
    const org = owner;
    const team = teams[state.index];
    if (key === "n") {
      ctx.push(
        promptScreen(ctx, screen, {
          title: "New team",
          label: "name [read|write|admin]",
          placeholder: "reviewers write",
          onSubmit: (value) => {
            const [teamName, permission] = value.split(/\s+/);
            if (!teamName) return "a name is required";
            const created = createTeam(
              f.app,
              f.user,
              org,
              teamName,
              permission === "write" || permission === "admin"
                ? permission
                : "read",
            );
            if (!created.ok) return errorText(created.error);
            reload();
            return undefined;
          },
        }),
      );
      return true;
    }
    if (key === "a" && team) {
      ctx.push(
        promptScreen(ctx, screen, {
          title: `Add to ${team.name}`,
          label: "username",
          onSubmit: (value) => {
            const added = addTeamMember(f.app, f.user, org, team, value);
            if (!added.ok) return errorText(added.error);
            reload();
            return undefined;
          },
        }),
      );
      return true;
    }
    if (key === "D" && team) {
      ctx.push(
        promptScreen(ctx, screen, {
          title: `Remove from ${team.name}`,
          label: "username",
          onSubmit: (value) => {
            const removed = removeTeamMember(f.app, f.user, org, team, value);
            if (!removed.ok) return errorText(removed.error);
            if (!removed.value.removed) return "that would leave no owners";
            reload();
            return undefined;
          },
        }),
      );
      return true;
    }
    return false;
  }

  return screen;
}
