/**
 * Billing in the terminal, a forge admin's who is a person: each forge's plan
 * and the hand grant, through the same `readBilling` and `grantPlan` the page
 * and API use. `s`, `m` or `l` grants the forge under the cursor that plan
 * after a yes/no; the change is kept in the audit trail like any other.
 */

import { grantPlan, readBilling, BILLING_WORDS } from "../../actions/billing.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, confirmScreen, drawList, yesNo, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";
const PLANS: Record<string, string> = { s: "small", m: "medium", l: "large" };

export function billingRows(f: Session): ListRow[] {
  const read = readBilling(f.app, f.user);
  if (!read.ok) return [];
  return read.value.forges.map((e) => ({ title: e.forge, secondary: e.plan, meta: `${e.status} · ${e.source}` }));
}

export function billingScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const screen: Screen = {
    title: "Billing",
    keys: [binding(["j", "k"], "move cursor"), binding(["s", "m", "l"], "grant small, medium, large"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const rows = billingRows(f);
      state.clamp(rows.length);
      if (rows.length === 0) {
        emptyState(s, area, c, { title: "No forge has been sent from here.", body: "Billing has nothing to grant yet." });
        return;
      }
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const line = note === "" ? "Every forge is free within its plan; a grant is recorded by hand" : note;
      s.text(head!.x, head!.y, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      const plan = PLANS[e.key];
      const rows = billingRows(f);
      const target = rows[state.index];
      if (plan !== undefined && target !== undefined) {
        const grant = (i: number): void => {
          if (i !== 0) return;
          const set = grantPlan(f.app, f.user, target.title, plan);
          note = set.ok ? `${target.title} is on ${plan}.` : set.error === "not_found" ? "Not found." : `${BILLING_WORDS[set.error]}.`;
          ctx.invalidate();
        };
        const ask = confirmScreen(ctx, screen, {
          title: "Grant a plan",
          body: [`Put ${target.title} on ${plan}?`],
          actions: [{ label: "Grant" }, { label: "Cancel" }],
          onChoose: grant,
        });
        ctx.push(yesNo(ctx, ask, grant));
        return true;
      }
      return state.key(e, rows.length);
    },
  };
  return screen;
}

/** Each forge's plan, and the grant. */
export const entry: PaletteEntry = {
  id: "billing",
  title: "Billing",
  hint: "each forge's plan, and grant one by hand",
  offered: isAdmin,
  run: (session, ctx) => ctx.push(billingScreen(session, ctx)),
};
