/**
 * "What I can do" in the terminal, as the account page and the `whoami_can`
 * tool have it: the signed-in account's role and its row of the roles table.
 * Read only.
 */

import { ABILITIES, roleOf, rowOf, type Ability } from "../../core/roles.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";

export function canScreen(f: Session, ctx: Ctx): Screen {
  return {
    title: "What I can do",
    keys: [binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      if (f.user === undefined) return;
      const role = roleOf(f.app.db, f.user);
      const row = rowOf(role);
      [`You are ${role} here.`, ...(Object.keys(ABILITIES) as Ability[]).map((a) => `${ABILITIES[a]}: ${row[a] ? "yes" : "no"}`)]
        .slice(0, Math.max(0, area.h))
        .forEach((l, i) => s.text(area.x, area.y + i, truncate(l, area.w), style(c.mutedFg, c.bg), area.x + area.w));
    },
    key: () => false,
  };
}
