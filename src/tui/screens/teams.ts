/**
 * Crew teams in the terminal, a forge admin's (#2679): the teams with their
 * dial and members, as /settings/teams shows them. Enter sets the dial, `c`
 * the charter, `m` the members (agent names, comma-separated). All go through
 * `changeTeam`, so the same checks, refusal sentences and kept change apply.
 * The gate is the action's: an admin who is not an agent; anyone else sees
 * nothing and sets nothing.
 */

import { pullsWaitingOn } from "../../actions/issue_teams.ts";
import { changeTeam, readTeams, teamChanges, TEAM_SAYS } from "../../actions/teams.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** The open pulls a team's review holds, oldest first: `pullsWaitingOn`, as the MCP tool lists them. */
function waitingScreen(f: Session, ctx: Ctx, slug: string, name: string): Screen {
  const state = new ListState();
  const read = () => {
    const w = pullsWaitingOn(f.app, f.user, slug);
    return w.ok ? w.value : [];
  };
  return {
    title: `${name} is holding`,
    keys: [binding(["j", "k"], "move cursor"), binding(["esc"], "back")],
    render(area, s) {
      const rows: ListRow[] = read().map((p) => ({
        title: `${p.repo}#${p.number} ${p.title}`,
        secondary: "",
        meta: `since ${p.since.slice(0, 10)}`,
      }));
      if (rows.length === 0)
        s.text(area.x + 1, area.y, `${name} is holding no pull.`, style(ctx.theme.c.mutedFg, ctx.theme.c.bg), area.x + area.w);
      else drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return state.key(e, read().length);
    },
  };
}

export function teamsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const read = () => readTeams(f.app, f.user);

  const save = (slug: string, raw: Parameters<typeof changeTeam>[3]): string | undefined => {
    const made = changeTeam(f.app, f.user, slug, raw);
    if (!made.ok) return TEAM_SAYS[made.error];
    note = `${made.value.name} saved at ${made.value.dial}%.`;
    ctx.invalidate();
    return undefined;
  };

  const rows = (): ListRow[] => {
    const r = read();
    if (!r.ok) return [];
    const names = new Map(r.value.agents.map((a) => [a.user.id, a.user.username]));
    return r.value.teams.map((t) => ({
      title: t.name,
      secondary: `${t.dial}%`,
      meta: t.members.map((id) => names.get(id) ?? id).join(", ") || "no members",
    }));
  };

  const screen: Screen = {
    title: "Crew teams",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["enter"], "dial"),
      binding(["c"], "charter"),
      binding(["m"], "members"),
      binding(["w"], "pulls it holds"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const r = read();
      const last = r.ok ? teamChanges(f.app, 1)[0] : undefined;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : !r.ok
            ? "Teams are set by a forge admin."
            : last === undefined
              ? "Dials together may not pass 100%. No change yet."
              : `${last.at.slice(0, 16)}  ${last.slug} ${last.from} → ${last.to}  ${last.actorName}`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows());
    },
    key(e) {
      const r = read();
      if (state.key(e, r.ok ? r.value.teams.length : 0)) return true;
      if (e.ctrl || e.alt || !r.ok) return false;
      const team = r.value.teams[state.index];
      if (team === undefined) return false;
      const ask = (label: string, value: string, onSubmit: (v: string) => string | undefined) =>
        ctx.push(promptScreen(ctx, screen, { title: team.name, label, value, onSubmit }));
      if (e.key === "enter")
        ask("a whole number from 0 to 100", String(team.dial), (v) => save(team.slug, { dial: v }));
      else if (e.key === "c")
        ask("what it owns, what it reviews", team.charter, (v) => save(team.slug, { charter: v.trim() }));
      else if (e.key === "w") ctx.push(waitingScreen(f, ctx, team.slug, team.name));
      else if (e.key === "m") {
        const byName = new Map(r.value.agents.map((a) => [a.user.username, a.user.id]));
        const names = new Map(r.value.agents.map((a) => [a.user.id, a.user.username]));
        ask(
          "agent names, comma-separated",
          team.members.map((id) => names.get(id) ?? id).join(", "),
          (v) => {
            const wanted = v.split(",").map((n) => n.trim()).filter((n) => n !== "");
            const ids = wanted.map((n) => byName.get(n));
            if (ids.some((id) => id === undefined)) return TEAM_SAYS.bad_member;
            return save(team.slug, { members: ids as string[] });
          },
        );
      } else return false;
      return true;
    },
  };
  return screen;
}

/** Crew teams, as /settings/teams has them: an admin who is not an agent (#2679). */
export const entry: PaletteEntry = {
  id: "teams",
  title: "Crew teams",
  hint: "each team's charter, dial and members",
  after: ["limits", "quotas", "people", "can"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(teamsScreen(session, ctx)),
};
