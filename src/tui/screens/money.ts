/**
 * The money line in the terminal (#510; docs/features/money.md): the board's
 * line and an app's month card from the same reads, `actions/money.ts`
 * `readForgeMoney` and `readAppMoney`, so the same gates hold — a site admin
 * who is a person for the forge's, the repository's admins and forge admins
 * for an app's. The forge's is a palette entry; an app's is a command while
 * its repository is open. Anyone else is offered neither and, were a screen
 * reached, sees no figures. Read-only; US dollars, UTC days.
 */

import { mayReadStatement } from "../../actions/statement.ts";
import { readAppMoney, readForgeMoney, type AppMoney, type ForgeMoney, type MoneyLine } from "../../actions/money.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { dollars, signed } from "../../web/studio/money_line.ts";
import { positionWord } from "../../core/slider.ts";

const figures = (m: MoneyLine): string => `cost ${dollars(m.cost)} · revenue ${dollars(m.revenue)} · gap ${signed(m.gap)}`;
const hours = (s: number): string => `${(s / 3600).toFixed(1)} h`;
const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");

/**
 * The month, today, the slider in the board's words (`positionWord`,
 * #11102: "balanced", not "50"), then each of the thirty days, newest first.
 */
export function forgeMoneyRows(m: ForgeMoney): ListRow[] {
  return [
    { title: `This month (${m.month})`, meta: figures(m.thisMonth) },
    { title: `Today (${m.today.day})`, meta: figures(m.today) },
    { title: "Economics slider", meta: positionWord(m.position) },
    ...[...m.days].reverse().map((d) => ({ title: d.day, meta: figures(d) })),
  ];
}

/** The app card's rows: the three numbers, where it was awake, and its share of the forge's own server. */
export function appMoneyRows(m: AppMoney): ListRow[] {
  const awake = m.ownedSeconds + m.cloudSeconds;
  return [
    { title: `This month (${m.month})`, meta: figures(m.thisMonth) },
    {
      title: "Awake",
      meta: `${hours(awake)} · ${pct(m.ownedSeconds, awake)} on the forge's own server · ${pct(m.cloudSeconds, awake)} on cloud`,
    },
    { title: "Share of the forge's own server", meta: pct(m.ownedShare, 1) },
  ];
}

export function moneyScreen(f: Session, ctx: Ctx, repo?: Repo): Screen {
  const state = new ListState();
  const rows = (): ListRow[] | undefined => {
    if (repo === undefined) {
      const m = readForgeMoney(f.app, f.user);
      return m.ok ? forgeMoneyRows(m.value) : undefined;
    }
    const m = readAppMoney(f.app, f.user, repo);
    return m.ok ? appMoneyRows(m.value) : undefined;
  };
  return {
    title: repo === undefined ? "Money" : `${repo.ownerName}/${repo.name} — Money`,
    keys: [binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const r = rows();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const said = r === undefined ? "" : "US dollars · days are UTC";
      s.text(head!.x, head!.y, truncate(said, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, r ?? []);
    },
    key: (e) => {
      const r = rows();
      return r !== undefined && state.key(e, r.length);
    },
  };
}

/** The board's money line: a site admin who is a person, as `readForgeMoney` holds. */
export const entry: PaletteEntry = {
  id: "money",
  title: "Money",
  hint: "this month's cost, revenue and gap, and the last 30 days",
  after: ["economics"],
  offered: (f) => f.user?.isAdmin === true && f.user.kind !== "agent",
  run: (f, ctx) => ctx.push(moneyScreen(f, ctx)),
};

/** "owner/name — Money" while a repository is open, to whoever may read its statement. */
export function moneyCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !mayReadStatement(f.app, repo, f.user)) return [];
  return [
    {
      id: "app-money",
      title: `${repo.ownerName}/${repo.name} — Money`,
      hint: "this app's cost, revenue and gap this month",
      run: () => ctx.push(moneyScreen(f, ctx, repo)),
    },
  ];
}
