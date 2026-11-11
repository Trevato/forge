/**
 * An app's statement in the terminal (#508): the page's lines and total
 * (`web/pages/statement.ts`) from the same read, `actions/statement.ts`
 * `readStatement`, so the same gate holds — the repository's admins and
 * forge admins. Offered from a repository's `:` palette to them alone;
 * anyone else, were the screen reached, sees no lines.
 *
 * `m` types a month (YYYY-MM, UTC), `[` and `]` step a month back and
 * forward. Read-only; amounts in US dollars.
 */

import { STATEMENT_WORDS, mayReadStatement, readStatement } from "../../actions/statement.ts";
import { monthOf, monthRange, parseMonth, type Statement } from "../../core/revenue.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";

/** A quantity or price as its plain digits, never an exponent. */
const plain = (n: number): string =>
  n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 6 });
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** The month before or after "YYYY-MM"; undefined before 2000-01. */
export function stepMonth(month: string, by: -1 | 1): string | undefined {
  const { from, to } = monthRange(month);
  const at = by === 1 ? to : new Date(Date.parse(from) - 1).toISOString();
  return parseMonth(monthOf(at));
}

/** One row per line, quantity × price = amount, then the total. */
export function statementRows(s: Statement): ListRow[] {
  return [
    ...s.lines.map((l) => ({
      title: l.what,
      meta: `${plain(l.quantity)} ${l.unit} × $${plain(l.price)} = ${usd(l.amount)}`,
    })),
    { title: "Total", meta: usd(s.total) },
  ];
}

export function statementScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let month: string | undefined;
  const read = () => readStatement(f.app, f.user, repo, month);
  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name} — Statement`,
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["m"], "month"),
      binding(["[", "]"], "previous/next month"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const r = read();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const said = r.ok ? `${r.value.month} (UTC) · USD` : r.error === "bad_month" ? STATEMENT_WORDS.bad_month : "";
      s.text(head!.x, head!.y, truncate(said, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, r.ok ? statementRows(r.value) : []);
    },
    key(e) {
      const r = read();
      if (!r.ok && r.error === "not_found") return false;
      if (state.key(e, r.ok ? r.value.lines.length + 1 : 0)) return true;
      if ((e.key === "[" || e.key === "]") && r.ok) {
        const next = stepMonth(r.value.month, e.key === "]" ? 1 : -1);
        if (next !== undefined) month = next;
        return true;
      }
      if (e.key === "m") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Statement month",
            label: "Month (UTC), YYYY-MM",
            placeholder: r.ok ? r.value.month : "2026-10",
            onSubmit: (value) => {
              if (parseMonth(value.trim()) === undefined) return `The ${STATEMENT_WORDS.bad_month}.`;
              month = value.trim();
              return undefined;
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

/** The palette's "Statement" while a repository is open, to its admins and forge admins. */
export function statementCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || !mayReadStatement(f.app, repo, f.user)) return [];
  return [
    {
      id: "app-statement",
      title: `${repo.ownerName}/${repo.name} — Statement`,
      hint: "what the forge would charge this app, a month at a time",
      run: () => ctx.push(statementScreen(f, ctx, repo)),
    },
  ];
}
