/**
 * The crew's Claude subscriptions in the terminal, for whoever MCP
 * `subscriptions` admits (a forge admin): name, kind, what it pays for,
 * budget and spend, and whether it rests; never a token. `w` wakes the
 * selected resting one and `b` sets its whole-life budget, with the rules of
 * MCP `subscription_wake` and `subscription_budget` (the core's, not new ones).
 */

import {
  budgetRefusal,
  budgetsOf,
  getSubscription,
  listSubscriptions,
  scopesOf,
  setBudget,
  wakeSubscription,
} from "../../core/subscriptions.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";

const money = (n: number): string => `$${n.toFixed(2)}`;

export function subscriptionsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const admitted = () => f.user?.isAdmin === true;
  const items = () => (admitted() ? listSubscriptions(f.app.db) : []);

  const rows = (): ListRow[] => {
    const budgets = budgetsOf(f.app.db);
    const scopes = scopesOf(f.app.db);
    const now = Date.now();
    return items().map((s) => {
      const b = budgets.get(s.id);
      const resting = s.restingUntil !== null && Date.parse(s.restingUntil) > now;
      const pays = (scopes.get(s.id) ?? []).join(", ");
      return {
        title: s.name,
        tone: resting ? "attn" : "success",
        secondary: `${s.kind}  ${pays === "" ? "pays for nothing" : `pays for ${pays}`}`,
        meta:
          `${b?.budgetUsd == null ? "no budget" : `budget ${money(b.budgetUsd)}`}  spent ${money(b?.spentUsd ?? 0)}  ` +
          (resting ? `resting until ${s.restingUntil}` : "awake"),
      };
    });
  };

  const setTo = (id: string, raw: string): string | undefined => {
    const text = raw.trim().toLowerCase();
    const usd = text === "none" ? null : /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
    if (usd !== null && !Number.isFinite(usd)) return "Dollars, like 25 — or none.";
    const refused = budgetRefusal(f.app.db, id, usd);
    if (refused) return refused.says.replace("or null for none", "or none");
    if (!setBudget(f.app.db, id, usd)) return "The budget was not saved.";
    note = usd === null ? "No budget: it spends until you stop it." : `Budget set: ${money(Math.round(usd * 100) / 100)} in all.`;
    ctx.invalidate();
    return undefined;
  };

  const screen: Screen = {
    title: "Crew subscriptions",
    keys: [binding(["j", "k"], "move cursor"), binding(["w"], "wake"), binding(["b"], "set budget"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const all = items();
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : all.length === 0 ? "No subscription yet." : "w wakes a resting one, b sets its budget.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      note = "";
      const all = items();
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || !admitted()) return false;
      const sub = all[state.index];
      if (e.key === "w" && sub !== undefined) {
        const now = getSubscription(f.app.db, sub.id);
        if (now === undefined) note = "No such subscription.";
        else if (now.restingUntil === null || Date.parse(now.restingUntil) <= Date.now())
          note = `${sub.name} is awake already.`;
        else {
          wakeSubscription(f.app.db, sub.id);
          note = `${sub.name}: in use again.`;
        }
        ctx.invalidate();
      } else if (e.key === "b" && sub !== undefined) {
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Budget for ${sub.name}`,
            label: "dollars in all (none clears it)",
            onSubmit: (raw) => setTo(sub.id, raw),
          }),
        );
      } else return false;
      return true;
    },
  };
  return screen;
}
