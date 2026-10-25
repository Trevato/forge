/**
 * People in the terminal, as `/settings/people` has them: every person with
 * a role and allowance, and `r` to make one a member (`member 5` gives a
 * starter $5 a month) or a guest. A forge admin who is a person; every rule
 * is the action's (`actions/roles.ts`).
 */

import { setRole } from "../../actions/roles.ts";
import { AMOUNT_REFUSED } from "../../actions/model_words.ts";
import { listPeople } from "../../core/roles.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { later, promptScreen } from "./common.ts";

export function peopleScreen(f: Session, ctx: Ctx): Screen {
  const screen: Screen = {
    title: "People",
    keys: [binding(["r"], "change a role"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      listPeople(f.app.db)
        .slice(0, Math.max(0, area.h))
        .forEach((p, i) => {
          const allowance = p.usdPerMonth === null ? "" : `  $${p.usdPerMonth.toFixed(2)} a month`;
          s.text(area.x, area.y + i, truncate(`${p.username}  ${p.role}${allowance}`, area.w), style(c.mutedFg, c.bg), area.x + area.w);
        });
    },
    key(e) {
      if (e.ctrl || e.alt || e.key !== "r") return false;
      ctx.push(
        promptScreen(ctx, screen, {
          title: "Change a role",
          label: "account name",
          onSubmit: (name) =>
            later(ctx, () =>
              promptScreen(ctx, screen, {
                title: `Role for ${name.trim()}`,
                label: "guest, member, or member 5 (dollars a month)",
                onSubmit: (raw) => {
                  const [role, amount, ...rest] = raw.trim().toLowerCase().split(/\s+/);
                  if ((role !== "member" && role !== "guest") || rest.length > 0 || (amount !== undefined && role !== "member"))
                    return "guest, member, or member 5.";
                  const usd = amount === undefined ? null : Number(amount);
                  if (usd !== null && !Number.isFinite(usd)) return "Dollars a month, like 5.";
                  const done = setRole(f.app, f.user, name.trim(), role, usd);
                  if (!done.ok) return done.error === "invalid_amount" ? AMOUNT_REFUSED : "No such account, or not one a role is for.";
                  ctx.toast(`${name.trim()} is a ${role}.`);
                  return undefined;
                },
              }),
            ),
        }),
      );
      return true;
    },
  };
  return screen;
}
