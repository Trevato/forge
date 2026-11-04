/**
 * Bets in the terminal (#8713): every bet of the repositories the signed-in
 * person administers, one row each, with the same actions as the page and the
 * MCP: `p` asks the planner for proposals, `b` backs with a share, `s` stops,
 * `c` cuts, `e` ends a stopped bet as done, `l` writes what is left, `d` says
 * it feels done and `n` not yet. All of it goes through `actions/bets.ts`, so
 * who may act, the rules and the events web pages follow are the same; an
 * agent, a guest or a reader without admin sees nothing and does nothing.
 */

import { backBet, endBet, giveVerdict, proposeBets, stopBet, writeLeft, type BetError } from "../../actions/bets.ts";
import { type Bet, listBets } from "../../core/bets.ts";
import { canAdmin, getRepoById, type Repo } from "../../core/repos.ts";
import type { Result } from "../../kernel/result.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, live, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

interface Line {
  readonly repo: Repo;
  readonly bet: Bet;
}

/** The repositories this session's person administers; none for a guest or an agent. */
function administered(f: Session): Repo[] {
  const user = f.user;
  if (user === undefined || user.kind === "agent") return [];
  return f.app.db
    .query<{ id: string }, [string]>("SELECT id FROM repo WHERE owner_id = ?1 ORDER BY name")
    .all(user.id)
    .flatMap((r) => {
      const repo = getRepoById(f.app.db, r.id);
      return repo !== undefined && canAdmin(f.app.db, repo, user) ? [repo] : [];
    });
}

export function betsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const lines = (): Line[] => administered(f).flatMap((repo) => listBets(f.app.db, repo.id).map((bet) => ({ repo, bet })));
  const say = (text: string): void => {
    note = text;
    ctx.invalidate();
  };
  const settle = (r: Result<Bet, { error: BetError; message: string }>, what: string): string | undefined => {
    say(r.ok ? `${r.value.name}: ${what}.` : r.error.message);
    return r.ok ? undefined : r.error.message;
  };

  const screen: Screen = {
    title: "Bets",
    keys: [
      binding(["j", "k"], "move cursor"), binding(["p"], "propose"), binding(["b"], "back"), binding(["s"], "stop"),
      binding(["c"], "cut"), binding(["e"], "end"), binding(["l"], "what is left"), binding(["d"], "feels done"), binding(["n"], "not yet"),
    ],
    async load(signal) {
      live(f, signal, { where: (e) => e.kind.startsWith("bet.") }, () => ctx.invalidate());
    },
    render(area, s) {
      const c = ctx.theme.c;
      const all = lines();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const sel = all[state.index];
      const text =
        note !== ""
          ? note
          : administered(f).length === 0
            ? "Bets are for the person who administers a repository."
            : sel
              ? sel.bet.leftLine || sel.bet.journeys.split("\n")[0] || sel.bet.name
              : "No bets. Press p to have the planner propose some.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = all.map(({ repo, bet }) => ({
        title: bet.name,
        ...(bet.state === "stopped" ? { tone: "danger" as const } : {}),
        secondary: `${repo.name} · ${bet.state} · ${bet.appetite}% of the week${bet.backedBy === "planner" ? " · not backed by the owner" : ""}`,
        meta: bet.state === "done" && bet.verdict === "" ? "try it, then d or n" : "",
      }));
      drawList(s, list!, c, state, rows);
    },
    key(e) {
      if (state.key(e, lines().length)) return true;
      if (e.ctrl || e.alt || f.user === undefined) return false;
      const all = lines();
      if (e.key === "p") {
        const repo = all[state.index]?.repo ?? administered(f)[0];
        if (repo === undefined) return false;
        const made = proposeBets(f.app, repo);
        say(made.length === 0 ? "Nothing new to propose." : `${made.length} proposed.`);
        return true;
      }
      const at = all[state.index];
      if (at === undefined) return false;
      const { repo, bet } = at;
      const user = f.user;
      if (e.key === "b")
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Back ${bet.name}`,
            label: "a share of the week, 1 to 100 (%)",
            value: String(bet.appetite),
            onSubmit: (raw) => settle(backBet(f.app, user, repo, bet.id, Number(raw.trim())), "backed"),
          }),
        );
      else if (e.key === "s") settle(stopBet(f.app, user, repo, bet.id), "stopped");
      else if (e.key === "e") settle(endBet(f.app, user, repo, bet.id, "done"), "ended as done");
      else if (e.key === "c")
        ctx.push(
          confirmScreen(ctx, screen, {
            title: `Cut ${bet.name}?`,
            body: ["Its scopes stay open issues; builders stop picking them for this bet."],
            actions: [{ label: "Cut it", variant: "danger" }, { label: "Keep" }],
            onChoose: (i) => {
              if (i === 0) settle(endBet(f.app, user, repo, bet.id, "cut"), "cut");
            },
          }),
        );
      else if (e.key === "l")
        ctx.push(
          promptScreen(ctx, screen, {
            title: `What is left of ${bet.name}`,
            label: "in one line",
            value: bet.leftLine,
            onSubmit: (raw) => settle(writeLeft(f.app, user, repo, bet.id, raw), "left written"),
          }),
        );
      else if (e.key === "d") settle(giveVerdict(f.app, user, repo, bet.id, "done", ""), "feels done");
      else if (e.key === "n")
        ctx.push(
          promptScreen(ctx, screen, {
            title: `${bet.name}: not yet`,
            label: "because",
            onSubmit: (raw) => settle(giveVerdict(f.app, user, repo, bet.id, "not_yet", raw), "not yet"),
          }),
        );
      else return false;
      return true;
    },
  };
  return screen;
}

/** Bets, as the page and the MCP have them: whoever administers a repository. */
export const entry: PaletteEntry = {
  id: "bets",
  title: "Bets",
  hint: "back, stop and finish a repository's bets",
  offered: (session) => session.user !== undefined && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(betsScreen(session, ctx)),
};
